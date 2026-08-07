package processors

import (
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// supportedFormats are the four image formats this slice's processors
// accept — the ones the spec's editor/pipeline examples actually need, not
// govips's full export surface (gif/tiff/heif/jp2k/jxl/magick have no
// caller). See docs/tasks/TASK-builtin-processors.md.
const (
	formatJPEG = "jpeg"
	formatPNG  = "png"
	formatWebP = "webp"
	formatAVIF = "avif"
)

const defaultQuality = 85

// exportFormat re-encodes img as format at quality (1-100; ignored for PNG,
// which has no lossy quality knob — see formatQuality mapping below).
func exportFormat(img *vips.ImageRef, format string, quality int) (data []byte, err error) {
	switch format {
	case formatJPEG:
		data, _, err = img.ExportJpeg(&vips.JpegExportParams{Quality: quality})
	case formatPNG:
		params := vips.NewPngExportParams()
		params.Compression = pngCompressionFromQuality(quality)
		data, _, err = img.ExportPng(params)
	case formatWebP:
		data, _, err = img.ExportWebp(&vips.WebpExportParams{Quality: quality})
	case formatAVIF:
		data, _, err = img.ExportAvif(&vips.AvifExportParams{Quality: quality})
	default:
		return nil, fmt.Errorf("unsupported format %q (must be one of jpeg, png, webp, avif)", format)
	}
	if err != nil {
		return nil, fmt.Errorf("export %s: %w", format, err)
	}
	return data, nil
}

// pngCompressionFromQuality maps a 1-100 "quality" onto libvips' PNG
// Compression 0-9 (0 = least compressed/largest, 9 = most compressed/CPU
// heaviest — the opposite direction from "quality"). This is a deliberate
// judgment call, not a governed spec value — see
// docs/tasks/TASK-builtin-processors.md "Porquê".
func pngCompressionFromQuality(quality int) int {
	c := 9 - (quality*9)/100
	if c < 0 {
		c = 0
	}
	if c > 9 {
		c = 9
	}
	return c
}

// originalFormatName maps govips's OriginalFormat() back to this package's
// format strings. Returns ok=false for any format outside the four this
// slice supports (e.g. bmp, gif, tiff, heif).
func originalFormatName(t vips.ImageType) (name string, ok bool) {
	switch t {
	case vips.ImageTypeJPEG:
		return formatJPEG, true
	case vips.ImageTypePNG:
		return formatPNG, true
	case vips.ImageTypeWEBP:
		return formatWebP, true
	case vips.ImageTypeAVIF:
		return formatAVIF, true
	default:
		return "", false
	}
}
