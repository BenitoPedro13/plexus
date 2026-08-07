package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
	"github.com/benitopedro13/plexus/workers/internal/render"
)

// gradient.jpg is the same 64x48 committed fixture
// workers/internal/processors' own tests use — see
// docs/tasks/TASK-builtin-processors.md.
const fixtureJPEG = "../../testdata/images/gradient.jpg"

func TestMain(m *testing.M) {
	if err := processors.Startup(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func newMultipartRequest(t *testing.T, filename string, fileBytes []byte, steps []render.RecipeStep) *http.Request {
	t.Helper()

	var body bytes.Buffer
	w := multipart.NewWriter(&body)

	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(fileBytes); err != nil {
		t.Fatalf("write file part: %v", err)
	}

	if steps != nil {
		recipeJSON, err := json.Marshal(steps)
		if err != nil {
			t.Fatalf("marshal recipe: %v", err)
		}
		if err := w.WriteField("recipe", string(recipeJSON)); err != nil {
			t.Fatalf("write recipe field: %v", err)
		}
	}

	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/render", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	return req
}

func TestRenderHandler(t *testing.T) {
	t.Run("empty recipe returns the uploaded file unchanged in shape", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		fileBytes, err := os.ReadFile(fixtureJPEG)
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}

		req := newMultipartRequest(t, "source.jpg", fileBytes, nil)
		rec := httptest.NewRecorder()
		renderHandler(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
			t.Fatalf("expected Content-Type image/jpeg, got %q", got)
		}
		if !bytes.Equal(rec.Body.Bytes(), fileBytes) {
			t.Fatal("expected the response body to equal the uploaded bytes for an empty recipe")
		}
	})

	t.Run("runs a real crop step and returns the rendered image", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		fileBytes, err := os.ReadFile(fixtureJPEG)
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}

		steps := []render.RecipeStep{
			{
				Processor: "image.crop",
				Params: map[string]interface{}{
					"x": 0.0, "y": 0.0, "width": 0.5, "height": 0.5,
				},
			},
		}

		req := newMultipartRequest(t, "source.jpg", fileBytes, steps)
		rec := httptest.NewRecorder()
		renderHandler(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}

		tmp := filepath.Join(t.TempDir(), "out.jpg")
		if err := os.WriteFile(tmp, rec.Body.Bytes(), 0o644); err != nil {
			t.Fatalf("write response to disk: %v", err)
		}

		img, err := vips.NewImageFromFile(tmp)
		if err != nil {
			t.Fatalf("decode response body as an image: %v", err)
		}
		defer img.Close()

		// 64x48 source cropped to 0..0.5 both axes -> 32x24.
		if img.Width() != 32 || img.Height() != 24 {
			t.Fatalf("expected 32x24 cropped output, got %dx%d", img.Width(), img.Height())
		}
	})

	t.Run("rejects a non-POST method", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/render", nil)
		rec := httptest.NewRecorder()
		renderHandler(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rec.Code)
		}
	})

	t.Run("rejects a missing file part", func(t *testing.T) {
		var body bytes.Buffer
		w := multipart.NewWriter(&body)
		if err := w.WriteField("recipe", "[]"); err != nil {
			t.Fatalf("write recipe field: %v", err)
		}
		if err := w.Close(); err != nil {
			t.Fatalf("close multipart writer: %v", err)
		}

		req := httptest.NewRequest(http.MethodPost, "/render", &body)
		req.Header.Set("Content-Type", w.FormDataContentType())
		rec := httptest.NewRecorder()
		renderHandler(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("a failing processor step surfaces as 422 with the underlying error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		fileBytes, err := os.ReadFile(fixtureJPEG)
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}

		steps := []render.RecipeStep{
			{Processor: "image.crop", Params: map[string]interface{}{"x": 2.0, "y": 0.0, "width": 1.0, "height": 1.0}},
		}

		req := newMultipartRequest(t, "source.jpg", fileBytes, steps)
		rec := httptest.NewRecorder()
		renderHandler(rec, req)

		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("expected 422, got %d: %s", rec.Code, rec.Body.String())
		}
	})
}
