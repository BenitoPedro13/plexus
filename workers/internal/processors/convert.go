package processors

import (
	"context"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// Convert implements the "image.convert" processor. Params:
//
//	format: required, one of "jpeg", "png", "webp", "avif".
//	quality: optional, 1-100, default 85. Ignored for png (no lossy
//	         quality knob — see pngCompressionFromQuality).
func Convert(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	format, err := requireStringParam(params, "format")
	if err != nil {
		return "", err
	}
	switch format {
	case formatJPEG, formatPNG, formatWebP, formatAVIF:
	default:
		return "", fmt.Errorf("param %q must be one of jpeg, png, webp, avif, got %q", "format", format)
	}

	quality, err := optionalIntParamInRange(params, "quality", defaultQuality, 1, 100)
	if err != nil {
		return "", err
	}

	img, err := vips.NewImageFromFile(inputRef)
	if err != nil {
		return "", fmt.Errorf("load %q: %w", inputRef, err)
	}
	defer img.Close()

	data, err := exportFormat(img, format, quality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}
