package processors_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// gradient.jpg / gradient.png are 64x48 committed fixtures — see
// docs/tasks/TASK-builtin-processors.md.
const (
	fixtureJPEG = "../../testdata/images/gradient.jpg"
	fixturePNG  = "../../testdata/images/gradient.png"
)

func TestResize(t *testing.T) {
	t.Run("fit inside preserves aspect ratio and does not exceed bounds", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.Resize(context.Background(), "step-inside", fixtureJPEG, map[string]interface{}{
			"width":  float64(32),
			"height": float64(32),
		})
		if err != nil {
			t.Fatalf("Resize: %v", err)
		}

		img, err := vips.NewImageFromFile(outputRef)
		if err != nil {
			t.Fatalf("load output %q: %v", outputRef, err)
		}
		defer img.Close()

		if img.Width() > 32 || img.Height() > 32 {
			t.Fatalf("expected output to fit within 32x32, got %dx%d", img.Width(), img.Height())
		}
		// 64x48 source, fit-inside to 32x32 -> width-bound, height scales to 24.
		if img.Width() != 32 || img.Height() != 24 {
			t.Fatalf("expected 32x24 (aspect-preserving fit), got %dx%d", img.Width(), img.Height())
		}
		if img.OriginalFormat() != vips.ImageTypeJPEG {
			t.Fatalf("expected resize to keep original format jpeg, got %v", vips.ImageTypes[img.OriginalFormat()])
		}
	})

	t.Run("fit cover crops to exact dimensions", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.Resize(context.Background(), "step-cover", fixtureJPEG, map[string]interface{}{
			"width":  float64(32),
			"height": float64(32),
			"fit":    "cover",
		})
		if err != nil {
			t.Fatalf("Resize: %v", err)
		}

		img, err := vips.NewImageFromFile(outputRef)
		if err != nil {
			t.Fatalf("load output %q: %v", outputRef, err)
		}
		defer img.Close()

		if img.Width() != 32 || img.Height() != 32 {
			t.Fatalf("expected exact 32x32 crop, got %dx%d", img.Width(), img.Height())
		}
	})

	t.Run("output path is under WORKER_STORAGE_DIR named by jobStepID", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("WORKER_STORAGE_DIR", dir)

		outputRef, err := processors.Resize(context.Background(), "job-step-123", fixtureJPEG, map[string]interface{}{
			"width":  float64(16),
			"height": float64(16),
		})
		if err != nil {
			t.Fatalf("Resize: %v", err)
		}

		want := filepath.Join(dir, "job-step-123.jpeg")
		if outputRef != want {
			t.Fatalf("expected outputRef %q, got %q", want, outputRef)
		}
	})

	t.Run("missing width is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Resize(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"height": float64(32),
		}); err == nil {
			t.Fatal("expected error for missing width, got nil")
		}
	})

	t.Run("missing height is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Resize(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"width": float64(32),
		}); err == nil {
			t.Fatal("expected error for missing height, got nil")
		}
	})

	t.Run("invalid fit value is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Resize(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"width":  float64(32),
			"height": float64(32),
			"fit":    "stretch",
		}); err == nil {
			t.Fatal("expected error for invalid fit value, got nil")
		}
	})

	t.Run("nonexistent input file is an error, not a panic", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Resize(context.Background(), "step", "/nonexistent/does-not-exist.jpg", map[string]interface{}{
			"width":  float64(32),
			"height": float64(32),
		}); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})
}
