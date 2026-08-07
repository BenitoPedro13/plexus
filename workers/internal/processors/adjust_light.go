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

// AdjustLight implements the "image.adjustLight" processor — the Light
// composite slider's P0 raw parameters, per
// docs/tasks/TASK-composite-slider-mapping.md's mapping table. Params (all
// required, no defaults — mirrors
// apps/web/src/lib/recipe/schema.ts's adjustLightParamsSchema):
//
//	exposure:   -3.0..3.0 (EV stops)
//	brightness: -1.0..1.0
//	contrast:   -1.0..1.0
//	blackPoint: 0.0..1.0 (fraction of the range remapped to black)
//
// Each param is applied as its own govips Linear1 pass, in the order
// exposure -> brightness -> contrast -> blackPoint, matching the mapping
// table's row order. Deferred: brilliance, highlights, shadows — blocked on
// V-7 (no exported govips Tonelut wrapper), see docs/90-deferred-register.md.
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

	img, err := vips.NewImageFromFile(inputRef)
	if err != nil {
		return "", fmt.Errorf("load %q: %w", inputRef, err)
	}
	defer img.Close()

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

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}
