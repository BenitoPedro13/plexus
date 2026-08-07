package processors

import (
	"context"
	"fmt"
	"math"

	"github.com/davidbyttow/govips/v2/vips"
)

// blackPointEpsilon floors (1 - blackPoint) before it's used as a divisor.
// The schema (apps/web/src/lib/recipe/schema.ts) allows blackPoint up to
// 1.0 inclusive, but TASK-composite-slider-mapping.md's formula divides by
// (1-blackPoint) — undefined at exactly 1.0. Flooring the denominator keeps
// blackPoint=1.0 a steep-but-finite clip to black instead of feeding
// govips's Linear1 an Inf/NaN coefficient.
const blackPointEpsilon = 1e-6

// toneLutAdjustScale converts this processor's -1.0..1.0 highlights/shadows
// range into libvips' own tonelut S/H "adjustment" range of -30..30
// (libvips/create/tonelut.c's documented VIPS_ARG_DOUBLE bounds).
const toneLutAdjustScale = 30.0

// AdjustLight implements the "image.adjustLight" processor — the Light
// composite slider's P0 raw parameters, per
// docs/tasks/TASK-composite-slider-mapping.md's mapping table, extended by
// docs/tasks/TASK-highlights-shadows-tonelut.md. Params — mirrors
// apps/web/src/lib/recipe/schema.ts's adjustLightParamsSchema:
//
//	exposure:   -3.0..3.0 (EV stops), required
//	brightness: -1.0..1.0, required
//	contrast:   -1.0..1.0, required
//	blackPoint: 0.0..1.0 (fraction of the range remapped to black), required
//	highlights: -1.0..1.0, optional, default 0.0
//	shadows:    -1.0..1.0, optional, default 0.0
//
// exposure/brightness/contrast/blackPoint are each their own govips Linear1
// pass, in that order, matching the mapping table's row order. highlights/
// shadows run afterward as a single govips tonelut->maplut pass on the
// LABS L band (libvips' own recommended shadows/highlights approach,
// github.com/libvips/libvips/discussions/4036), via the local govips fork's
// Tonelut/MaplutBand (workers/internal/govips-fork/vips/tonelut.go — see
// the resolved V-7 in docs/90-deferred-register.md for why a fork was
// needed). Sign convention: shadows positive = brighter shadows (matches
// libvips' own S, "raise shadows"); highlights positive = darker/recovered
// highlights (Apple Photos/Lightroom's convention, the opposite of libvips'
// raw H, "raise highlights" — H is negated below for that reason). Deferred:
// brilliance — no libvips primitive identified, see
// docs/90-deferred-register.md.
func AdjustLight(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	exposure, err := requireFloatParamInRange(params, "exposure", -3.0, 3.0)
	if err != nil {
		return "", err
	}
	brightness, err := requireFloatParamInRange(params, "brightness", -1.0, 1.0)
	if err != nil {
		return "", err
	}
	contrast, err := requireFloatParamInRange(params, "contrast", -1.0, 1.0)
	if err != nil {
		return "", err
	}
	blackPoint, err := requireFloatParamInRange(params, "blackPoint", 0.0, 1.0)
	if err != nil {
		return "", err
	}
	highlights, err := optionalFloatParamInRange(params, "highlights", 0.0, -1.0, 1.0)
	if err != nil {
		return "", err
	}
	shadows, err := optionalFloatParamInRange(params, "shadows", 0.0, -1.0, 1.0)
	if err != nil {
		return "", err
	}

	img, err := vips.NewImageFromFile(inputRef)
	if err != nil {
		return "", fmt.Errorf("load %q: %w", inputRef, err)
	}
	defer func() { img.Close() }()

	format, ok := originalFormatName(img.OriginalFormat())
	if !ok {
		return "", fmt.Errorf("input %q has unsupported format %s", inputRef, vips.ImageTypes[img.OriginalFormat()])
	}

	if err := img.Linear1(math.Pow(2, exposure), 0); err != nil {
		return "", fmt.Errorf("apply exposure: %w", err)
	}
	if err := img.Linear1(1, brightness*255); err != nil {
		return "", fmt.Errorf("apply brightness: %w", err)
	}
	if err := img.Linear1(1+contrast, -128*contrast); err != nil {
		return "", fmt.Errorf("apply contrast: %w", err)
	}
	denom := 1 - blackPoint
	if denom < blackPointEpsilon {
		denom = blackPointEpsilon
	}
	if err := img.Linear1(1/denom, -blackPoint/denom*255); err != nil {
		return "", fmt.Errorf("apply blackPoint: %w", err)
	}

	if highlights != 0 || shadows != 0 {
		adjusted, err := applyHighlightsShadows(img, highlights, shadows)
		if err != nil {
			return "", err
		}
		img.Close()
		img = adjusted
	}

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}

// applyHighlightsShadows runs libvips' documented tonelut->maplut shadows/
// highlights recovery pipeline (github.com/libvips/libvips/discussions/4036)
// against img's L band and returns a new *vips.ImageRef with the result —
// img itself is left untouched; the caller is responsible for closing both.
// Converts to LABS (confirmed from libvips' Lab2LabS.c: band 0 is a signed
// short where 0..32767 represents logical L 0..100, so Tonelut's default
// InMax/OutMax of 32767 line up with the real data with no rescaling),
// builds a LUT with S (shadows) and H (highlights, sign-negated per this
// processor's doc comment) driven by the recipe params and everything else
// at libvips' own tonelut defaults (Lb=0, Lw=100, Ps=0.2, Pm=0.5, Ph=0.8),
// extracts band 0 (L), maps it through the LUT, rejoins it with the
// untouched a/b bands, and restores the original interpretation/color
// space.
//
// Deliberately extract/rejoin rather than mapping the LUT over the whole
// 3-band LABS image via maplut's "band" option: verified experimentally
// (see the doc comment on the local govips fork's Tonelut, workers/
// internal/govips-fork/vips/tonelut.go) that doing so corrupts the
// untouched a/b bands, because libvips' vips_maplut_build relabels the
// *entire* output image's BandFmt as the LUT's format regardless of which
// band was actually mapped.
func applyHighlightsShadows(img *vips.ImageRef, highlights, shadows float64) (*vips.ImageRef, error) {
	original := img.Interpretation()

	labs, err := img.Copy()
	if err != nil {
		return nil, fmt.Errorf("copy for highlights/shadows: %w", err)
	}
	defer labs.Close()
	if err := labs.ToColorSpace(vips.InterpretationLABS); err != nil {
		return nil, fmt.Errorf("convert to LABS for highlights/shadows: %w", err)
	}

	l, err := labs.ExtractBandToImage(0, 1)
	if err != nil {
		return nil, fmt.Errorf("extract L band for highlights/shadows: %w", err)
	}
	defer l.Close()
	ab, err := labs.ExtractBandToImage(1, 2)
	if err != nil {
		return nil, fmt.Errorf("extract a/b bands for highlights/shadows: %w", err)
	}
	defer ab.Close()

	s := shadows * toneLutAdjustScale
	h := -highlights * toneLutAdjustScale
	lut, err := vips.Tonelut(&vips.TonelutOptions{S: &s, H: &h})
	if err != nil {
		return nil, fmt.Errorf("build highlights/shadows tonelut: %w", err)
	}
	defer lut.Close()

	if err := l.Maplut(lut); err != nil {
		return nil, fmt.Errorf("apply highlights/shadows maplut: %w", err)
	}
	// maplut's output BandFmt always follows the LUT (unsigned short) —
	// cast back to LABS's signed short before rejoining with a/b so the
	// combined image's format promotion isn't driven by an unnecessary
	// unsigned/signed mismatch.
	if err := l.Cast(vips.BandFormatShort); err != nil {
		return nil, fmt.Errorf("cast L band back to short for highlights/shadows: %w", err)
	}

	if err := l.BandJoin(ab); err != nil {
		return nil, fmt.Errorf("rejoin highlights/shadows L with a/b bands: %w", err)
	}
	joined, err := l.CopyChangingInterpretation(vips.InterpretationLABS)
	if err != nil {
		return nil, fmt.Errorf("restore LABS interpretation after highlights/shadows: %w", err)
	}

	if err := joined.ToColorSpace(original); err != nil {
		joined.Close()
		return nil, fmt.Errorf("restore color space after highlights/shadows: %w", err)
	}

	return joined, nil
}
