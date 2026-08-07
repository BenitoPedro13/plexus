package processors

import (
	"context"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// AdjustColor implements the "image.adjustColor" processor — the Color
// composite slider's P0 raw parameter, per
// docs/tasks/TASK-composite-slider-mapping.md's mapping table. Params:
//
//	saturation: -1.0..1.0, required.
//
// Deferred: cast (unblocked, not yet implemented — D-27), vibrance (blend
// primitives identified but exact curve is a visual judgment call — D-29),
// see docs/90-deferred-register.md and docs/tasks/TASK-vibrance-cast-grain-spike.md.
func AdjustColor(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	saturation, err := requireFloatParamInRange(params, "saturation", -1.0, 1.0)
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

	if err := img.Modulate(1, 1+saturation, 0); err != nil {
		return "", fmt.Errorf("apply saturation: %w", err)
	}

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}
