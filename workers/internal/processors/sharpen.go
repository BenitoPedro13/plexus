package processors

import (
	"context"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// Sharpen implements the "image.sharpen" processor — the Sharpen composite
// slider's P0 raw parameter, per
// docs/tasks/TASK-composite-slider-mapping.md's mapping table. Params:
//
//	intensity: 0.0..1.0, required.
//
// sigma=0.5 and x1=2 are fixed at libvips' own documented screen-output
// defaults (https://www.libvips.org/API/8.17/method.Image.sharpen.html);
// only m2 (the jaggy-area slope) scales with intensity. Deferred: edges,
// falloff — no clean govips primitive found for either, see
// docs/90-deferred-register.md.
func Sharpen(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	intensity, err := requireFloatParamInRange(params, "intensity", 0.0, 1.0)
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

	if err := img.Sharpen(0.5, 2, 3*intensity); err != nil {
		return "", fmt.Errorf("apply sharpen: %w", err)
	}

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}
