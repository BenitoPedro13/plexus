package processors_test

import (
	"context"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestCompress(t *testing.T) {
	t.Run("keeps original format and dimensions", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.Compress(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"quality": float64(50),
		})
		if err != nil {
			t.Fatalf("Compress: %v", err)
		}

		img, err := vips.NewImageFromFile(outputRef)
		if err != nil {
			t.Fatalf("load output %q: %v", outputRef, err)
		}
		defer img.Close()

		if img.OriginalFormat() != vips.ImageTypeJPEG {
			t.Fatalf("expected format jpeg, got %v", vips.ImageTypes[img.OriginalFormat()])
		}
		if img.Width() != 64 || img.Height() != 48 {
			t.Fatalf("expected dimensions unchanged at 64x48, got %dx%d", img.Width(), img.Height())
		}
	})

	t.Run("lower quality produces a smaller jpeg", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		low, err := processors.Compress(context.Background(), "step-low", fixtureJPEG, map[string]interface{}{
			"quality": float64(10),
		})
		if err != nil {
			t.Fatalf("Compress (low): %v", err)
		}
		high, err := processors.Compress(context.Background(), "step-high", fixtureJPEG, map[string]interface{}{
			"quality": float64(95),
		})
		if err != nil {
			t.Fatalf("Compress (high): %v", err)
		}

		if fileSize(t, low) >= fileSize(t, high) {
			t.Fatalf("expected quality=10 output to be smaller than quality=95 output")
		}
	})

	t.Run("png compress maps quality to compression level", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.Compress(context.Background(), "step", fixturePNG, map[string]interface{}{
			"quality": float64(50),
		})
		if err != nil {
			t.Fatalf("Compress: %v", err)
		}

		img, err := vips.NewImageFromFile(outputRef)
		if err != nil {
			t.Fatalf("load output %q: %v", outputRef, err)
		}
		defer img.Close()

		if img.OriginalFormat() != vips.ImageTypePNG {
			t.Fatalf("expected format png, got %v", vips.ImageTypes[img.OriginalFormat()])
		}
	})

	t.Run("missing quality is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Compress(context.Background(), "step", fixtureJPEG, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing quality, got nil")
		}
	})

	t.Run("quality out of range is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Compress(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"quality": float64(0),
		}); err == nil {
			t.Fatal("expected error for out-of-range quality, got nil")
		}
	})
}
