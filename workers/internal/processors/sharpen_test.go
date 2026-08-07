package processors_test

import (
	"context"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// Note: gradient.jpg/gradient.png (this package's only fixtures) are smooth
// linear gradients with no edges/high-frequency detail, so govips's
// unsharp-mask Sharpen produces no measurable pixel difference on them at
// any intensity (verified: identical output bytes at intensity=0 vs 1) —
// there is nothing here to assert a *visible* sharpening effect against.
// These tests cover format/dimension preservation and param validation
// only; see docs/90-deferred-register.md's new V-item for a fixture with
// actual edges to measure the real effect against.
func TestSharpen(t *testing.T) {
	t.Run("keeps original format and dimensions across the intensity range", func(t *testing.T) {
		for _, intensity := range []float64{0, 0.5, 1} {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			outputRef, err := processors.Sharpen(context.Background(), "step", fixtureJPEG, map[string]interface{}{
				"intensity": intensity,
			})
			if err != nil {
				t.Fatalf("Sharpen(intensity=%v): %v", intensity, err)
			}

			img, err := vips.NewImageFromFile(outputRef)
			if err != nil {
				t.Fatalf("load output %q: %v", outputRef, err)
			}
			if img.OriginalFormat() != vips.ImageTypeJPEG {
				t.Fatalf("expected format jpeg, got %v", vips.ImageTypes[img.OriginalFormat()])
			}
			if img.Width() != 64 || img.Height() != 48 {
				t.Fatalf("expected dimensions unchanged at 64x48, got %dx%d", img.Width(), img.Height())
			}
			img.Close()
		}
	})

	t.Run("missing intensity is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Sharpen(context.Background(), "step", fixtureJPEG, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing intensity, got nil")
		}
	})

	for _, val := range []float64{-0.1, 1.1} {
		val := val
		t.Run("intensity out of range is a validation error", func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			if _, err := processors.Sharpen(context.Background(), "step", fixtureJPEG, map[string]interface{}{
				"intensity": val,
			}); err == nil {
				t.Fatalf("expected error for intensity=%v, got nil", val)
			}
		})
	}

	t.Run("nonexistent input file is an error, not a panic", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Sharpen(context.Background(), "step", "/nonexistent/does-not-exist.jpg", map[string]interface{}{
			"intensity": float64(0.5),
		}); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})
}
