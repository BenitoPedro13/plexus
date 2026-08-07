package processors

import (
	"context"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// Compress implements the "image.compress" processor. Params:
//
//	quality: required, 1-100.
//
// Re-exports the input in its original format at the requested quality —
// compress never changes format (that's Convert's job). Only jpeg, png,
// webp, and avif originals are supported; anything else is a validation
// error, not a silent no-op.
func Compress(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	quality, err := requireIntParamInRange(params, "quality", 1, 100)
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
		return "", fmt.Errorf("input %q has unsupported format %s for compress (must be jpeg, png, webp, or avif)", inputRef, vips.ImageTypes[img.OriginalFormat()])
	}

	data, err := exportFormat(img, format, quality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}
