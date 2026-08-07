package processors_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// gradient.jpg is a 64x48 committed fixture — see docs/tasks/TASK-builtin-processors.md.
func TestCrop(t *testing.T) {
	t.Run("crops to the exact requested pixel rect", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.Crop(context.Background(), "step-crop", fixtureJPEG, map[string]interface{}{
			"x":      0.25,
			"y":      0.25,
			"width":  0.5,
			"height": 0.5,
		})
		if err != nil {
			t.Fatalf("Crop: %v", err)
		}

		img, err := vips.NewImageFromFile(outputRef)
		if err != nil {
			t.Fatalf("load output %q: %v", outputRef, err)
		}
		defer img.Close()

		// 64x48 source: x/y=0.25 -> left=16,top=12; width/height=0.5 -> 32x24.
		if img.Width() != 32 || img.Height() != 24 {
			t.Fatalf("expected 32x24 crop, got %dx%d", img.Width(), img.Height())
		}
		if img.OriginalFormat() != vips.ImageTypeJPEG {
			t.Fatalf("expected crop to keep original format jpeg, got %v", vips.ImageTypes[img.OriginalFormat()])
		}
	})

	t.Run("full-frame crop is a same-size no-op", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.Crop(context.Background(), "step-full", fixtureJPEG, map[string]interface{}{
			"x":      0.0,
			"y":      0.0,
			"width":  1.0,
			"height": 1.0,
		})
		if err != nil {
			t.Fatalf("Crop: %v", err)
		}

		img, err := vips.NewImageFromFile(outputRef)
		if err != nil {
			t.Fatalf("load output %q: %v", outputRef, err)
		}
		defer img.Close()

		if img.Width() != 64 || img.Height() != 48 {
			t.Fatalf("expected full 64x48, got %dx%d", img.Width(), img.Height())
		}
	})

	t.Run("edge-of-bounds crop does not error from rounding drift", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		// x=0.99, width=0.02 sums to 1.01 > 1.0 at the param level so use a
		// pair that's valid but rounds right at the boundary: x+width == 1.0
		// exactly, with an odd source dimension in play (64 is even, so
		// exercise the height axis against 48 with an off-half split).
		if _, err := processors.Crop(context.Background(), "step-edge", fixtureJPEG, map[string]interface{}{
			"x":      0.9,
			"y":      0.1,
			"width":  0.1,
			"height": 0.9,
		}); err != nil {
			t.Fatalf("Crop: %v", err)
		}
	})

	t.Run("output path is under WORKER_STORAGE_DIR named by jobStepID", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("WORKER_STORAGE_DIR", dir)

		outputRef, err := processors.Crop(context.Background(), "job-step-123", fixtureJPEG, map[string]interface{}{
			"x":      0.0,
			"y":      0.0,
			"width":  0.5,
			"height": 0.5,
		})
		if err != nil {
			t.Fatalf("Crop: %v", err)
		}

		want := filepath.Join(dir, "job-step-123.jpeg")
		if outputRef != want {
			t.Fatalf("expected outputRef %q, got %q", want, outputRef)
		}
	})

	t.Run("missing x is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Crop(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"y": 0.0, "width": 0.5, "height": 0.5,
		}); err == nil {
			t.Fatal("expected error for missing x, got nil")
		}
	})

	t.Run("zero width is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Crop(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.5,
		}); err == nil {
			t.Fatal("expected error for zero width, got nil")
		}
	})

	t.Run("x+width exceeding 1.0 is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Crop(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"x": 0.6, "y": 0.0, "width": 0.6, "height": 0.5,
		}); err == nil {
			t.Fatal("expected error for x+width > 1.0, got nil")
		}
	})

	t.Run("y+height exceeding 1.0 is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Crop(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"x": 0.0, "y": 0.6, "width": 0.5, "height": 0.6,
		}); err == nil {
			t.Fatal("expected error for y+height > 1.0, got nil")
		}
	})

	t.Run("out-of-range x is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Crop(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"x": 1.5, "y": 0.0, "width": 0.1, "height": 0.1,
		}); err == nil {
			t.Fatal("expected error for out-of-range x, got nil")
		}
	})

	t.Run("nonexistent input file is an error, not a panic", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Crop(context.Background(), "step", "/nonexistent/does-not-exist.jpg", map[string]interface{}{
			"x": 0.0, "y": 0.0, "width": 0.5, "height": 0.5,
		}); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})
}
