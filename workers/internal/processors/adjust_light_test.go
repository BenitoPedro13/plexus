package processors_test

import (
	"context"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func adjustLight(t *testing.T, jobStepID string, params map[string]interface{}) string {
	t.Helper()
	outputRef, err := processors.AdjustLight(context.Background(), jobStepID, fixtureJPEG, params)
	if err != nil {
		t.Fatalf("AdjustLight: %v", err)
	}
	return outputRef
}

func TestAdjustLight(t *testing.T) {
	identity := map[string]interface{}{
		"exposure": float64(0), "brightness": float64(0), "contrast": float64(0), "blackPoint": float64(0),
	}

	t.Run("keeps original format and dimensions", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef := adjustLight(t, "step", identity)

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

	t.Run("positive exposure brightens", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		base := imageAverage(t, adjustLight(t, "step-base", identity))
		bright := imageAverage(t, adjustLight(t, "step-bright", map[string]interface{}{
			"exposure": float64(1), "brightness": float64(0), "contrast": float64(0), "blackPoint": float64(0),
		}))

		if bright <= base {
			t.Fatalf("expected exposure=1 to increase average brightness, got base=%v bright=%v", base, bright)
		}
	})

	t.Run("negative exposure darkens", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		base := imageAverage(t, adjustLight(t, "step-base", identity))
		dark := imageAverage(t, adjustLight(t, "step-dark", map[string]interface{}{
			"exposure": float64(-1), "brightness": float64(0), "contrast": float64(0), "blackPoint": float64(0),
		}))

		if dark >= base {
			t.Fatalf("expected exposure=-1 to decrease average brightness, got base=%v dark=%v", base, dark)
		}
	})

	t.Run("positive brightness increases average", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		base := imageAverage(t, adjustLight(t, "step-base", identity))
		brighter := imageAverage(t, adjustLight(t, "step-brighter", map[string]interface{}{
			"exposure": float64(0), "brightness": float64(0.3), "contrast": float64(0), "blackPoint": float64(0),
		}))

		if brighter <= base {
			t.Fatalf("expected brightness=0.3 to increase average, got base=%v brighter=%v", base, brighter)
		}
	})

	t.Run("negative brightness decreases average", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		base := imageAverage(t, adjustLight(t, "step-base", identity))
		darker := imageAverage(t, adjustLight(t, "step-darker", map[string]interface{}{
			"exposure": float64(0), "brightness": float64(-0.3), "contrast": float64(0), "blackPoint": float64(0),
		}))

		if darker >= base {
			t.Fatalf("expected brightness=-0.3 to decrease average, got base=%v darker=%v", base, darker)
		}
	})

	t.Run("blackPoint=1.0 clips fully black without erroring or NaN output", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		avg := imageAverage(t, adjustLight(t, "step-blackpoint", map[string]interface{}{
			"exposure": float64(0), "brightness": float64(0), "contrast": float64(0), "blackPoint": float64(1.0),
		}))

		if avg != 0 {
			t.Fatalf("expected blackPoint=1.0 to clip the image fully black (avg 0), got %v", avg)
		}
	})

	for _, key := range []string{"exposure", "brightness", "contrast", "blackPoint"} {
		key := key
		t.Run("missing "+key+" is a validation error", func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			params := map[string]interface{}{}
			for _, k := range []string{"exposure", "brightness", "contrast", "blackPoint"} {
				if k != key {
					params[k] = float64(0)
				}
			}

			if _, err := processors.AdjustLight(context.Background(), "step", fixtureJPEG, params); err == nil {
				t.Fatalf("expected error for missing %q, got nil", key)
			}
		})
	}

	for _, tc := range []struct {
		key string
		val float64
	}{
		{"exposure", 3.1},
		{"exposure", -3.1},
		{"brightness", 1.1},
		{"contrast", -1.1},
		{"blackPoint", -0.1},
		{"blackPoint", 1.1},
	} {
		tc := tc
		t.Run(tc.key+" out of range is a validation error", func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			params := map[string]interface{}{
				"exposure": float64(0), "brightness": float64(0), "contrast": float64(0), "blackPoint": float64(0),
			}
			params[tc.key] = tc.val

			if _, err := processors.AdjustLight(context.Background(), "step", fixtureJPEG, params); err == nil {
				t.Fatalf("expected error for %s=%v, got nil", tc.key, tc.val)
			}
		})
	}

	t.Run("nonexistent input file is an error, not a panic", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AdjustLight(context.Background(), "step", "/nonexistent/does-not-exist.jpg", identity); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})
}
