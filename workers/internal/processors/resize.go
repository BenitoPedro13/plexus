package processors

import (
	"context"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// Resize implements the "image.resize" processor. Params:
//
//	width, height: required, positive integers (pixels).
//	fit: optional, "inside" (default, scale to fit within width x height,
//	     no crop) or "cover" (crop-to-fill width x height).
//
// Single-dimension resize (only width or only height) is out of scope for
// this slice — see docs/tasks/TASK-builtin-processors.md "Porquê". Output
// keeps the input's original format; resize never changes format.
func Resize(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	width, err := requirePositiveIntParam(params, "width")
	if err != nil {
		return "", err
	}
	height, err := requirePositiveIntParam(params, "height")
	if err != nil {
		return "", err
	}

	crop := vips.InterestingNone
	if fitVal, ok := params["fit"]; ok {
		fit, ok := fitVal.(string)
		if !ok {
			return "", fmt.Errorf("param %q must be a string", "fit")
		}
		switch fit {
		case "", "inside":
			crop = vips.InterestingNone
		case "cover":
			crop = vips.InterestingCentre
		default:
			return "", fmt.Errorf("param %q must be %q or %q, got %q", "fit", "inside", "cover", fit)
		}
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

	if err := img.Thumbnail(width, height, crop); err != nil {
		return "", fmt.Errorf("resize %q to %dx%d: %w", inputRef, width, height, err)
	}

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}
