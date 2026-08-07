package processors_test

import (
	"context"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestAdjustColor(t *testing.T) {
	t.Run("keeps original format and dimensions", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.AdjustColor(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"saturation": float64(0),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
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

	t.Run("saturation=-1 fully desaturates (zero channel spread)", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.AdjustColor(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"saturation": float64(-1),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
		}

		if spread := channelSpread(t, outputRef, 0, 0); spread > 2 {
			// small tolerance for JPEG quantization noise around an
			// exact-zero target.
			t.Fatalf("expected saturation=-1 to collapse channel spread near 0, got %v", spread)
		}
	})

	t.Run("positive saturation increases channel spread", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		base, err := processors.AdjustColor(context.Background(), "step-base", fixtureJPEG, map[string]interface{}{
			"saturation": float64(0),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
		}
		boosted, err := processors.AdjustColor(context.Background(), "step-boosted", fixtureJPEG, map[string]interface{}{
			"saturation": float64(1),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
		}

		baseSpread := channelSpread(t, base, 0, 0)
		boostedSpread := channelSpread(t, boosted, 0, 0)
		if boostedSpread <= baseSpread {
			t.Fatalf("expected saturation=1 to increase channel spread, got base=%v boosted=%v", baseSpread, boostedSpread)
		}
	})

	t.Run("missing saturation is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AdjustColor(context.Background(), "step", fixtureJPEG, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing saturation, got nil")
		}
	})

	for _, val := range []float64{-1.1, 1.1} {
		val := val
		t.Run("saturation out of range is a validation error", func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			if _, err := processors.AdjustColor(context.Background(), "step", fixtureJPEG, map[string]interface{}{
				"saturation": val,
			}); err == nil {
				t.Fatalf("expected error for saturation=%v, got nil", val)
			}
		})
	}

	t.Run("nonexistent input file is an error, not a panic", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AdjustColor(context.Background(), "step", "/nonexistent/does-not-exist.jpg", map[string]interface{}{
			"saturation": float64(0),
		}); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})
}
