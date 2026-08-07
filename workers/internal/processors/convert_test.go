package processors_test

import (
	"context"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestConvert(t *testing.T) {
	cases := []struct {
		format   string
		wantType vips.ImageType
	}{
		{"jpeg", vips.ImageTypeJPEG},
		{"png", vips.ImageTypePNG},
		{"webp", vips.ImageTypeWEBP},
		{"avif", vips.ImageTypeAVIF},
	}

	for _, tc := range cases {
		t.Run(tc.format, func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			outputRef, err := processors.Convert(context.Background(), "step-"+tc.format, fixtureJPEG, map[string]interface{}{
				"format": tc.format,
			})
			if err != nil {
				t.Fatalf("Convert: %v", err)
			}

			img, err := vips.NewImageFromFile(outputRef)
			if err != nil {
				t.Fatalf("load output %q: %v", outputRef, err)
			}
			defer img.Close()

			if img.OriginalFormat() != tc.wantType {
				t.Fatalf("expected format %v, got %v", tc.wantType, vips.ImageTypes[img.OriginalFormat()])
			}
			// Convert doesn't resize — dimensions must be unchanged.
			if img.Width() != 64 || img.Height() != 48 {
				t.Fatalf("expected dimensions unchanged at 64x48, got %dx%d", img.Width(), img.Height())
			}
		})
	}

	t.Run("respects quality param", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		lowQ, err := processors.Convert(context.Background(), "step-lowq", fixturePNG, map[string]interface{}{
			"format":  "jpeg",
			"quality": float64(10),
		})
		if err != nil {
			t.Fatalf("Convert (low quality): %v", err)
		}
		highQ, err := processors.Convert(context.Background(), "step-highq", fixturePNG, map[string]interface{}{
			"format":  "jpeg",
			"quality": float64(95),
		})
		if err != nil {
			t.Fatalf("Convert (high quality): %v", err)
		}

		lowSize := fileSize(t, lowQ)
		highSize := fileSize(t, highQ)
		if lowSize >= highSize {
			t.Fatalf("expected low-quality output (%d bytes) to be smaller than high-quality (%d bytes)", lowSize, highSize)
		}
	})

	t.Run("missing format is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Convert(context.Background(), "step", fixtureJPEG, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing format, got nil")
		}
	})

	t.Run("unsupported format is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Convert(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"format": "gif",
		}); err == nil {
			t.Fatal("expected error for unsupported format, got nil")
		}
	})

	t.Run("quality out of range is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.Convert(context.Background(), "step", fixtureJPEG, map[string]interface{}{
			"format":  "jpeg",
			"quality": float64(101),
		}); err == nil {
			t.Fatal("expected error for out-of-range quality, got nil")
		}
	})
}
