package render_test

import (
	"context"
	"os"
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

func TestRunRecipe(t *testing.T) {
	t.Run("empty recipe returns the source path unchanged", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		out, cleanup, err := render.RunRecipe(context.Background(), render.NewRenderID(), fixtureJPEG, nil)
		if err != nil {
			t.Fatalf("RunRecipe: %v", err)
		}
		defer cleanup()

		if out != fixtureJPEG {
			t.Fatalf("expected output path to equal source path %q, got %q", fixtureJPEG, out)
		}

		if _, err := os.Stat(fixtureJPEG); err != nil {
			t.Fatalf("cleanup must not remove the source file: %v", err)
		}
	})

	t.Run("chains crop, resize, and adjustLight in recipe order through real processors", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		steps := []render.RecipeStep{
			{
				Processor: "image.crop",
				Params: map[string]interface{}{
					"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5,
				},
			},
			{
				Processor: "image.resize",
				Params: map[string]interface{}{
					"width": float64(16), "height": float64(16), "fit": "inside",
				},
			},
			{
				Processor: "image.adjustLight",
				Params: map[string]interface{}{
					"exposure": 0.5, "brightness": 0.0, "contrast": 0.0, "blackPoint": 0.0,
				},
			},
		}

		out, cleanup, err := render.RunRecipe(context.Background(), render.NewRenderID(), fixtureJPEG, steps)
		if err != nil {
			t.Fatalf("RunRecipe: %v", err)
		}
		defer cleanup()

		// 64x48 source: crop to 0.25..0.75 both axes -> 32x24, then resize
		// "inside" 16x16 -> preserves aspect, capped at 16 on the wider
		// dimension (32x24 -> 16x12).
		img, err := vips.NewImageFromFile(out)
		if err != nil {
			t.Fatalf("load chained output %q: %v", out, err)
		}
		defer img.Close()

		if img.Width() != 16 || img.Height() != 12 {
			t.Fatalf("expected 16x12 after crop+resize, got %dx%d", img.Width(), img.Height())
		}

		if _, err := os.Stat(fixtureJPEG); err != nil {
			t.Fatalf("cleanup must not remove the source file: %v", err)
		}
	})

	t.Run("unknown processor id fails the whole chain and cleans up prior steps", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("WORKER_STORAGE_DIR", dir)

		steps := []render.RecipeStep{
			{Processor: "image.crop", Params: map[string]interface{}{"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}},
			{Processor: "image.doesNotExist", Params: map[string]interface{}{}},
		}

		_, cleanup, err := render.RunRecipe(context.Background(), render.NewRenderID(), fixtureJPEG, steps)
		if err == nil {
			t.Fatal("expected an error for an unknown processor id")
		}
		cleanup()

		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			t.Fatalf("read storage dir: %v", readErr)
		}
		if len(entries) != 0 {
			t.Fatalf("expected the first step's output to be cleaned up on failure, found %d leftover file(s)", len(entries))
		}
	})

	t.Run("a failing step's error identifies which step and processor failed", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		steps := []render.RecipeStep{
			{Processor: "image.crop", Params: map[string]interface{}{"x": 2.0, "y": 0.0, "width": 1.0, "height": 1.0}},
		}

		_, cleanup, err := render.RunRecipe(context.Background(), render.NewRenderID(), fixtureJPEG, steps)
		if err == nil {
			t.Fatal("expected an error for an out-of-range crop param")
		}
		cleanup()

		const wantPrefix = "step 0 (image.crop):"
		if got := err.Error(); len(got) < len(wantPrefix) || got[:len(wantPrefix)] != wantPrefix {
			t.Fatalf("expected error to start with %q, got %q", wantPrefix, got)
		}
	})
}
