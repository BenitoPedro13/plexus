package processors_test

import (
	"context"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func blackAndWhite(t *testing.T, jobStepID string, params map[string]interface{}) string {
	t.Helper()
	outputRef, err := processors.BlackAndWhite(context.Background(), jobStepID, fixtureJPEG, params)
	if err != nil {
		t.Fatalf("BlackAndWhite: %v", err)
	}
	return outputRef
}

func TestBlackAndWhite(t *testing.T) {
	t.Run("keeps original format and dimensions", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef := blackAndWhite(t, "step", map[string]interface{}{
			"intensity": float64(0), "neutrals": float64(0), "tone": float64(0),
		})

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

	t.Run("intensity=0 leaves the image in color (unchanged channel spread)", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef := blackAndWhite(t, "step", map[string]interface{}{
			"intensity": float64(0), "neutrals": float64(0), "tone": float64(0),
		})

		if spread := channelSpread(t, outputRef, 0, 0); spread < 100 {
			t.Fatalf("expected intensity=0 to preserve color (large channel spread), got %v", spread)
		}
	})

	t.Run("intensity=1 fully desaturates (zero channel spread)", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef := blackAndWhite(t, "step", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0),
		})

		if spread := channelSpread(t, outputRef, 0, 0); spread > 2 {
			// small tolerance for JPEG quantization noise around an
			// exact-zero target.
			t.Fatalf("expected intensity=1 to collapse channel spread near 0, got %v", spread)
		}
	})

	t.Run("intermediate intensity partially desaturates", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		full := channelSpread(t, blackAndWhite(t, "step-full", map[string]interface{}{
			"intensity": float64(0), "neutrals": float64(0), "tone": float64(0),
		}), 0, 0)
		half := channelSpread(t, blackAndWhite(t, "step-half", map[string]interface{}{
			"intensity": float64(0.5), "neutrals": float64(0), "tone": float64(0),
		}), 0, 0)

		if half >= full || half <= 2 {
			t.Fatalf("expected intensity=0.5 spread strictly between 0 and full color, got full=%v half=%v", full, half)
		}
	})

	t.Run("positive tone increases grayscale contrast (higher average at intensity=1)", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		// gradient.jpg's mean pixel (~137) sits above the contrast
		// pivot (128), so a positive tone (contrast) push should raise
		// the post-grayscale average, and a negative one should lower it.
		base := imageAverage(t, blackAndWhite(t, "step-base", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0),
		}))
		toned := imageAverage(t, blackAndWhite(t, "step-toned", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0.3),
		}))

		if toned <= base {
			t.Fatalf("expected tone=0.3 to increase average above tone=0 baseline, got base=%v toned=%v", base, toned)
		}
	})

	t.Run("grain absent and grain=0 are identical (default no-op)", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		absent := blackAndWhite(t, "step-absent", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0),
		})
		explicit := blackAndWhite(t, "step-explicit", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0), "grain": float64(0),
		})

		if !bytesEqual(t, absent, explicit) {
			t.Fatal("expected omitted grain and grain=0 to produce byte-identical output")
		}
	})

	t.Run("grain=1 measurably increases pixel-value variance", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		plain := blackAndWhite(t, "step-plain", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0), "grain": float64(0),
		})
		grained := blackAndWhite(t, "step-grained", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0), "grain": float64(1),
		})

		plainSpread := sampledVariance(t, plain)
		grainedSpread := sampledVariance(t, grained)

		if grainedSpread <= plainSpread {
			t.Fatalf("expected grain=1 to increase sampled variance above grain=0, got plain=%v grained=%v", plainSpread, grainedSpread)
		}
	})

	t.Run("grain=1 keeps the average close to the ungrained baseline (zero-mean noise)", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		base := imageAverage(t, blackAndWhite(t, "step-base", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0), "grain": float64(0),
		}))
		grained := imageAverage(t, blackAndWhite(t, "step-grained", map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0), "grain": float64(1),
		}))

		if diff := grained - base; diff > 5 || diff < -5 {
			t.Fatalf("expected grain=1 average within 5 of grain=0 baseline (%v), got %v", base, grained)
		}
	})

	t.Run("grain output is deterministic across runs", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		params := map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0), "grain": float64(0.5),
		}
		first := blackAndWhite(t, "step-first", params)
		second := blackAndWhite(t, "step-second", params)

		if !bytesEqual(t, first, second) {
			t.Fatal("expected identical grain params to produce byte-identical output across runs")
		}
	})

	t.Run("grain=1 on an RGBA input leaves alpha unchanged", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("WORKER_STORAGE_DIR", dir)

		rgbaPath := writeUniformRGBAPNG(t, dir, 200, 120, 80, 180)

		outputRef, err := processors.BlackAndWhite(context.Background(), "step-rgba", rgbaPath, map[string]interface{}{
			"intensity": float64(1), "neutrals": float64(0), "tone": float64(0), "grain": float64(1),
		})
		if err != nil {
			t.Fatalf("BlackAndWhite: %v", err)
		}

		img, err := vips.NewImageFromFile(outputRef)
		if err != nil {
			t.Fatalf("load output %q: %v", outputRef, err)
		}
		defer img.Close()

		if !img.HasAlpha() {
			t.Fatal("expected output to keep an alpha band")
		}

		alphaBand, err := img.ExtractBandToImage(img.Bands()-1, 1)
		if err != nil {
			t.Fatalf("extract alpha band: %v", err)
		}
		defer alphaBand.Close()

		alphaAvg, err := alphaBand.Average()
		if err != nil {
			t.Fatalf("average alpha band: %v", err)
		}
		if diff := alphaAvg - 180; diff > 1 || diff < -1 {
			t.Fatalf("expected alpha band to remain ~180 (unchanged by grain), got %v", alphaAvg)
		}
	})

	for _, key := range []string{"intensity", "neutrals", "tone"} {
		key := key
		t.Run("missing "+key+" is a validation error", func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			params := map[string]interface{}{}
			for _, k := range []string{"intensity", "neutrals", "tone"} {
				if k != key {
					params[k] = float64(0)
				}
			}

			if _, err := processors.BlackAndWhite(context.Background(), "step", fixtureJPEG, params); err == nil {
				t.Fatalf("expected error for missing %q, got nil", key)
			}
		})
	}

	for _, tc := range []struct {
		key string
		val float64
	}{
		{"intensity", -0.1},
		{"intensity", 1.1},
		{"neutrals", -1.1},
		{"neutrals", 1.1},
		{"tone", -1.1},
		{"tone", 1.1},
		{"grain", -0.1},
		{"grain", 1.1},
	} {
		tc := tc
		t.Run(tc.key+" out of range is a validation error", func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			params := map[string]interface{}{
				"intensity": float64(0), "neutrals": float64(0), "tone": float64(0),
			}
			params[tc.key] = tc.val

			if _, err := processors.BlackAndWhite(context.Background(), "step", fixtureJPEG, params); err == nil {
				t.Fatalf("expected error for %s=%v, got nil", tc.key, tc.val)
			}
		})
	}

	t.Run("nonexistent input file is an error, not a panic", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.BlackAndWhite(context.Background(), "step", "/nonexistent/does-not-exist.jpg", map[string]interface{}{
			"intensity": float64(0), "neutrals": float64(0), "tone": float64(0),
		}); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})
}
