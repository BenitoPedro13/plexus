package processors

import (
	"context"
	"fmt"
	"math"

	"github.com/davidbyttow/govips/v2/vips"
)

// cropBoundsEpsilon tolerates float rounding in x+width / y+height sums
// right at the 1.0 boundary — same role as adjust_color.go's
// castMeanEpsilon, a fixed small slack rather than an exact-equality check.
const cropBoundsEpsilon = 1e-6

// Crop implements the "image.crop" processor. Params (all required):
//
//	x, y:          0.0..1.0, top-left corner of the crop rect, as a fraction
//	               of the source image's width/height.
//	width, height: 0.0..1.0 (exclusive of 0), size of the crop rect, also as
//	               a fraction of the source image's width/height.
//	               x+width and y+height must each be <= 1.0.
//
// Coordinates are normalized rather than absolute pixels so the same recipe
// step is correct at both live-preview resolution and full-resolution
// export — see docs/tasks/TASK-image-crop.md "Porquê". Pixel bounds are
// computed from the *input* image's actual dimensions at processing time
// (img.Width()/img.Height()), rounded to the nearest pixel, then clamped so
// rounding can never push the rect past the source bounds — govips's
// ExtractArea errors on an out-of-bounds rect rather than clamping itself.
// Output keeps the input's original format; crop never changes format.
func Crop(_ context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	x, err := requireFloatParamInRange(params, "x", 0.0, 1.0)
	if err != nil {
		return "", err
	}
	y, err := requireFloatParamInRange(params, "y", 0.0, 1.0)
	if err != nil {
		return "", err
	}
	width, err := requireFloatParamInRange(params, "width", 0.0, 1.0)
	if err != nil {
		return "", err
	}
	if width <= 0 {
		return "", fmt.Errorf("param %q must be greater than 0, got %v", "width", width)
	}
	height, err := requireFloatParamInRange(params, "height", 0.0, 1.0)
	if err != nil {
		return "", err
	}
	if height <= 0 {
		return "", fmt.Errorf("param %q must be greater than 0, got %v", "height", height)
	}
	if x+width > 1.0+cropBoundsEpsilon {
		return "", fmt.Errorf("param %q + %q must not exceed 1.0, got %v", "x", "width", x+width)
	}
	if y+height > 1.0+cropBoundsEpsilon {
		return "", fmt.Errorf("param %q + %q must not exceed 1.0, got %v", "y", "height", y+height)
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

	srcW, srcH := img.Width(), img.Height()
	left := int(math.Round(x * float64(srcW)))
	top := int(math.Round(y * float64(srcH)))
	cropW := int(math.Round(width * float64(srcW)))
	cropH := int(math.Round(height * float64(srcH)))

	if left > srcW-1 {
		left = srcW - 1
	}
	if top > srcH-1 {
		top = srcH - 1
	}
	if left+cropW > srcW {
		cropW = srcW - left
	}
	if top+cropH > srcH {
		cropH = srcH - top
	}
	if cropW < 1 {
		cropW = 1
	}
	if cropH < 1 {
		cropH = 1
	}

	if err := img.ExtractArea(left, top, cropW, cropH); err != nil {
		return "", fmt.Errorf("crop %q to %d,%d %dx%d: %w", inputRef, left, top, cropW, cropH, err)
	}

	data, err := exportFormat(img, format, defaultQuality)
	if err != nil {
		return "", err
	}

	return writeOutput(jobStepID, format, data)
}
