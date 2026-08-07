package processors

import (
	"context"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// blackAndWhiteBaseWeight is the equal-weight [0.33, 0.33, 0.33] mix
// TASK-composite-slider-mapping.md's "neutrals" row describes as the base
// (neutrals=0) grayscale conversion, expressed as an exact fraction.
const blackAndWhiteBaseWeight = 1.0 / 3.0

// grainMaxSigma is the vips_gaussnoise sigma (0-255 uchar scale) at
// grain=1.0. A first-pass upper bound, not empirically tuned against real
// photos — same status as grayscaleMatrix's neutrals skew above. Gentler
// than libvips' own gaussnoise default of 30 (docs/tasks/
// TASK-black-and-white-grain.md's verification). Revisit per D-29's
// trigger: the first time a real photo is dragged through /editor.
const grainMaxSigma = 25.0

// grainNoiseSeed fixes vips_gaussnoise's seed so grain output is
// deterministic — required for golden-fixture tests and for a recipe to
// reproduce the same output on repeat export (CLAUDE.md's recipe-fidelity
// requirement). The specific value is arbitrary; determinism is the point.
const grainNoiseSeed = 42

// grayscaleMatrix builds the 3x3 Recomb matrix that converts to grayscale
// while skewing the mix toward (positive) or away from (negative) green per
// neutrals, per docs/tasks/TASK-composite-slider-mapping.md: "matrix rows
// derived from a base equal-weight [0.33,0.33,0.33] mix skewed by neutrals
// toward/away from green". Every output band uses the same [r, g, b]
// weights, so the result is a true grayscale image (R=G=B) rather than a
// tinted recombination — this folds the mapping doc's separate "grayscale
// via ToColorSpace(BW)" formula (intensity's row) and Recomb formula
// (neutrals' row) into one operation, since neutrals controls how that
// grayscale is computed. green = base + neutrals*base keeps red/blue
// symmetric and the row summing to 1 (± float rounding), so overall
// luminance is preserved across the slider's range. The exact skew curve is
// a first-pass choice, not empirically tuned against real photos — see
// docs/90-deferred-register.md.
func grayscaleMatrix(neutrals float64) [][]float64 {
	green := blackAndWhiteBaseWeight + neutrals*blackAndWhiteBaseWeight
	redBlue := (1 - green) / 2
	row := []float64{redBlue, green, redBlue}
	return [][]float64{row, row, row}
}

// BlackAndWhite implements the "image.blackAndWhite" processor — the B&W
// composite slider's P0 raw parameters, per
// docs/tasks/TASK-composite-slider-mapping.md's mapping table. Params:
//
//	intensity: 0.0..1.0 (blend original -> grayscale)
//	neutrals:  -1.0..1.0 (channel-mix skew, see grayscaleMatrix)
//	tone:      -1.0..1.0 (contrast, applied to the grayscale layer)
//	grain:     0.0..1.0, optional, default 0.0 (additive noise, see grainMaxSigma)
//
// Composition: grayscale (skewed by neutrals) -> tone (contrast, applied
// "post-grayscale" per the mapping table) -> linear-blend with the original
// by intensity -> grain (additive noise, applied last — a property of the
// final print, not an input layer). Recomb auto-expands its matrix to
// preserve a 4th (alpha) band as an identity passthrough (confirmed against
// github.com/davidbyttow/govips/v2 v2.18.0's Recomb source), and Linear1
// applies its scalar uniformly across all bands, so alpha survives the
// intensity blend unchanged for inputs that have one — not exercised by
// this package's fixtures (gradient.jpg/gradient.png are both opaque
// 3-band), so treat that as read-from-source, not measured. grain's alpha
// safety (band-matched, zero-valued alpha addend) is measured, per
// docs/tasks/TASK-black-and-white-grain.md.
func BlackAndWhite(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	intensity, err := requireFloatParamInRange(params, "intensity", 0.0, 1.0)
	if err != nil {
		return "", err
	}
	neutrals, err := requireFloatParamInRange(params, "neutrals", -1.0, 1.0)
	if err != nil {
		return "", err
	}
	tone, err := requireFloatParamInRange(params, "tone", -1.0, 1.0)
	if err != nil {
		return "", err
	}
	grain, err := optionalFloatParamInRange(params, "grain", 0.0, 0.0, 1.0)
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

	gray, err := img.Copy()
	if err != nil {
		return "", fmt.Errorf("copy for grayscale layer: %w", err)
	}
	defer gray.Close()

	if err := gray.Recomb(grayscaleMatrix(neutrals)); err != nil {
		return "", fmt.Errorf("apply neutrals: %w", err)
	}
	if err := gray.Linear1(1+tone, -128*tone); err != nil {
		return "", fmt.Errorf("apply tone: %w", err)
	}

	if err := img.Linear1(1-intensity, 0); err != nil {
		return "", fmt.Errorf("apply intensity (original layer): %w", err)
	}
	if err := gray.Linear1(intensity, 0); err != nil {
		return "", fmt.Errorf("apply intensity (grayscale layer): %w", err)
	}
	if err := img.Add(gray); err != nil {
		return "", fmt.Errorf("blend grayscale into original: %w", err)
	}

	if grain != 0 {
		if err := applyGrain(img, grain); err != nil {
			return "", err
		}
	}

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}

// applyGrain adds zero-mean Gaussian noise to img in place, scaled by
// intensity (0.0..1.0) up to grainMaxSigma. Uses plain arithmetic Add
// rather than Composite/BlendMode — verified (TASK-black-and-white-grain.md)
// that Composite's "add" blend mode synthesizes an unwanted 4th alpha band
// on alpha-less inputs, while Add does not. The noise image is built at
// img's own dimensions (a size mismatch silently changes Add's output size
// rather than erroring) and replicated to match img's band count exactly:
// three bands of identical noise (an achromatic broadcast, confirmed
// empirically) plus, only if img has alpha, one constant-zero band so the
// alpha channel gets a no-op +0 rather than picking up noise itself.
func applyGrain(img *vips.ImageRef, grain float64) error {
	sigma := grain * grainMaxSigma
	mean := 0.0
	seed := grainNoiseSeed

	noise, err := vips.NewGaussnoiseImage(img.Width(), img.Height(), &vips.GaussnoiseOptions{
		Sigma: &sigma,
		Mean:  &mean,
		Seed:  &seed,
	})
	if err != nil {
		return fmt.Errorf("generate grain noise: %w", err)
	}
	defer noise.Close()

	if err := noise.BandJoin(noise, noise); err != nil {
		return fmt.Errorf("replicate grain noise to color bands: %w", err)
	}
	if img.HasAlpha() {
		if err := noise.BandJoinConst([]float64{0}); err != nil {
			return fmt.Errorf("pad grain noise with zero alpha band: %w", err)
		}
	}

	if err := img.Add(noise); err != nil {
		return fmt.Errorf("apply grain: %w", err)
	}
	return nil
}
