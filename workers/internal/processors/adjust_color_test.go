package processors_test

import (
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// bandMean loads path and returns govips's Average() for a single band --
// used to assert AdjustColor's castStrength grey-world correction actually
// equalizes per-channel means, unlike channelSpread which only samples one
// pixel.
func bandMean(t *testing.T, path string, band int) float64 {
	t.Helper()
	img, err := vips.NewImageFromFile(path)
	if err != nil {
		t.Fatalf("load %q: %v", path, err)
	}
	defer img.Close()

	bandImg, err := img.ExtractBandToImage(band, 1)
	if err != nil {
		t.Fatalf("extract band %d from %q: %v", band, path, err)
	}
	defer bandImg.Close()

	avg, err := bandImg.Average()
	if err != nil {
		t.Fatalf("average band %d of %q: %v", band, path, err)
	}
	return avg
}

// writeGrayscaleJPEG creates a small single-band (grayscale) JPEG fixture
// in dir and returns its path -- used to assert castStrength rejects
// inputs with no color bands to correct, rather than panicking.
func writeGrayscaleJPEG(t *testing.T, dir string) string {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.Gray{Y: 128})
		}
	}
	path := filepath.Join(dir, "grayscale.jpg")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %q: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatalf("encode %q: %v", path, err)
	}
	return path
}

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

	t.Run("castStrength=0 is a no-op, matching the omitted-param default", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		explicit, err := processors.AdjustColor(context.Background(), "step-explicit", fixtureJPEG, map[string]interface{}{
			"saturation":   float64(0),
			"castStrength": float64(0),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
		}
		omitted, err := processors.AdjustColor(context.Background(), "step-omitted", fixtureJPEG, map[string]interface{}{
			"saturation": float64(0),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
		}

		for band := 0; band < 3; band++ {
			e, o := bandMean(t, explicit, band), bandMean(t, omitted, band)
			if e != o {
				t.Fatalf("band %d: castStrength=0 mean %v != omitted-param mean %v", band, e, o)
			}
		}
	})

	t.Run("castStrength=1 converges per-band means (grey-world corrected)", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		uncorrected, err := processors.AdjustColor(context.Background(), "step-uncorrected", fixtureJPEG, map[string]interface{}{
			"saturation": float64(0),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
		}
		corrected, err := processors.AdjustColor(context.Background(), "step-corrected", fixtureJPEG, map[string]interface{}{
			"saturation":   float64(0),
			"castStrength": float64(1),
		})
		if err != nil {
			t.Fatalf("AdjustColor: %v", err)
		}

		spread := func(path string) float64 {
			means := [3]float64{bandMean(t, path, 0), bandMean(t, path, 1), bandMean(t, path, 2)}
			min, max := means[0], means[0]
			for _, m := range means {
				if m < min {
					min = m
				}
				if m > max {
					max = m
				}
			}
			return max - min
		}

		uncorrectedSpread := spread(uncorrected)
		correctedSpread := spread(corrected)
		if correctedSpread >= uncorrectedSpread {
			t.Fatalf("expected castStrength=1 to shrink per-band mean spread, got uncorrected=%v corrected=%v", uncorrectedSpread, correctedSpread)
		}
		if correctedSpread > 2 {
			// small tolerance for JPEG re-encode quantization noise around
			// an exact-equal target (measured ~0.17 on gradient.jpg).
			t.Fatalf("expected castStrength=1 to nearly equalize per-band means, got spread %v", correctedSpread)
		}
	})

	for _, val := range []float64{-0.1, 1.1} {
		val := val
		t.Run("castStrength out of range is a validation error", func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			if _, err := processors.AdjustColor(context.Background(), "step", fixtureJPEG, map[string]interface{}{
				"saturation":   float64(0),
				"castStrength": val,
			}); err == nil {
				t.Fatalf("expected error for castStrength=%v, got nil", val)
			}
		})
	}

	t.Run("castStrength on a grayscale input is an error, not a panic", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("WORKER_STORAGE_DIR", dir)
		grayscale := writeGrayscaleJPEG(t, dir)

		if _, err := processors.AdjustColor(context.Background(), "step", grayscale, map[string]interface{}{
			"saturation":   float64(0),
			"castStrength": float64(0.5),
		}); err == nil {
			t.Fatal("expected error for castStrength on a grayscale input, got nil")
		}
	})
}
