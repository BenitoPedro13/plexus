package processors

import (
	"context"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// castMeanEpsilon floors a per-band mean before it's used as a divisor in
// AdjustColor's grey-world castStrength correction — same role as
// adjust_light.go's blackPointEpsilon. A fully black color band (mean 0)
// would otherwise produce an infinite scale factor.
const castMeanEpsilon = 1e-6

// AdjustColor implements the "image.adjustColor" processor — the Color
// composite slider's P0 raw parameters, per
// docs/tasks/TASK-composite-slider-mapping.md's mapping table, extended by
// docs/tasks/TASK-adjust-color-cast.md (resolved D-27). Params:
//
//	saturation:   -1.0..1.0, required.
//	castStrength: 0.0..1.0, optional, default 0.0.
//
// castStrength runs a grey-world white-balance correction ahead of the
// saturation boost (matches Apple Photos/Lightroom's own ordering, white
// balance before vibrance/saturation): the per-channel mean of R/G/B is
// computed, each channel is scaled toward the mean of those three means,
// and castStrength linearly blends between the original image (0.0) and
// the fully corrected one (1.0). Requires at least 3 bands (a grayscale
// input has no color cast to correct).
//
// Deferred: vibrance (blend primitives identified but exact curve is a
// visual judgment call — D-29), see docs/90-deferred-register.md and
// docs/tasks/TASK-vibrance-cast-grain-spike.md.
func AdjustColor(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	saturation, err := requireFloatParamInRange(params, "saturation", -1.0, 1.0)
	if err != nil {
		return "", err
	}
	castStrength, err := optionalFloatParamInRange(params, "castStrength", 0.0, 0.0, 1.0)
	if err != nil {
		return "", err
	}

	img, err := vips.NewImageFromFile(inputRef)
	if err != nil {
		return "", fmt.Errorf("load %q: %w", inputRef, err)
	}
	defer img.Close()

	format, ok := originalFormatName(img.OriginalFormat())
	if !ok {
		return "", fmt.Errorf("input %q has unsupported format %s", inputRef, vips.ImageTypes[img.OriginalFormat()])
	}

	if castStrength != 0 {
		if err := applyCast(img, castStrength); err != nil {
			return "", err
		}
	}

	if err := img.Modulate(1, 1+saturation, 0); err != nil {
		return "", fmt.Errorf("apply saturation: %w", err)
	}

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}

// applyCast runs a grey-world white-balance correction on img in place,
// blended by castStrength (0.0 = no-op, 1.0 = full correction). Reads
// per-band means via ExtractBandToImage+Average rather than govips' Stats
// — Stats() mutates the image into a 1-band stats image whose per-band
// values can only be read back through GetPoint, whose public wrapper
// hardcodes a 3/4-element read regardless of the stats image's actual
// (1) band count; empirically this returns correct data zero-padded, but
// that relies on unstated C-level buffer behavior rather than a
// documented guarantee. ExtractBandToImage+Average avoids it entirely.
func applyCast(img *vips.ImageRef, castStrength float64) error {
	bands := img.Bands()
	if bands < 3 {
		return fmt.Errorf("castStrength requires at least 3 color bands, got %d", bands)
	}

	means := make([]float64, 3)
	for b := 0; b < 3; b++ {
		bandImg, err := img.ExtractBandToImage(b, 1)
		if err != nil {
			return fmt.Errorf("extract band %d: %w", b, err)
		}
		mean, err := bandImg.Average()
		bandImg.Close()
		if err != nil {
			return fmt.Errorf("average band %d: %w", b, err)
		}
		means[b] = mean
	}
	target := (means[0] + means[1] + means[2]) / 3

	// vips_linear requires its coefficient vector to have length 1 or
	// exactly Bands() (confirmed empirically: a 3-element vector against a
	// 4-band RGBA image fails with "linear: vector must have 1 or 4
	// elements") — bands beyond R/G/B (alpha) get an identity coefficient.
	a := make([]float64, bands)
	b := make([]float64, bands)
	for i := 0; i < bands; i++ {
		a[i] = 1
	}
	for i := 0; i < 3; i++ {
		mean := means[i]
		if mean < castMeanEpsilon {
			mean = castMeanEpsilon
		}
		scale := target / mean
		a[i] = 1 + castStrength*(scale-1)
	}

	if err := img.Linear(a, b); err != nil {
		return fmt.Errorf("apply castStrength: %w", err)
	}
	return nil
}
