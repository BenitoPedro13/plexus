// Command gendriftfixture synthesizes testdata/drift/source.png, the shared
// input fixture for the recipe-fidelity drift measurement
// (docs/tasks/TASK-recipe-fidelity-drift.md). Run manually:
//
//	go run ./cmd/gendriftfixture
//
// Not part of `go test` or CI — its output is committed and only
// regenerated deliberately. Uses Go's stdlib image/png, not govips: this is
// synthetic test data, not a production media-processing operation, so
// CLAUDE.md's "no hand-rolled media processing" rule doesn't apply here.
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

const (
	size        = 128
	outputPath  = "../testdata/drift/source.png"
	checkerTile = 8
)

func main() {
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var c color.RGBA
			switch {
			case y < size/3:
				c = gradientPixel(x)
			case y < 2*size/3:
				c = huePatchPixel(x)
			default:
				c = checkerPixel(x, y)
			}
			img.SetRGBA(x, y, c)
		}
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		log.Fatalf("mkdir: %v", err)
	}
	f, err := os.Create(outputPath)
	if err != nil {
		log.Fatalf("create %q: %v", outputPath, err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			log.Fatalf("close %q: %v", outputPath, err)
		}
	}()

	if err := png.Encode(f, img); err != nil {
		log.Fatalf("encode png: %v", err)
	}
	log.Printf("wrote %s", outputPath)
}

// gradientPixel: top third — smooth low-saturation luminance ramp, left
// (black) to right (white). Exercises image.adjustLight and the
// intensity/tone blend of image.blackAndWhite.
func gradientPixel(x int) color.RGBA {
	v := uint8(x * 255 / (size - 1))
	return color.RGBA{R: v, G: v, B: v, A: 255}
}

// huePatchPixel: middle third — six solid hue patches spanning the color
// wheel at fixed saturation/lightness. Exercises image.adjustColor's
// saturation scaling and image.blackAndWhite's neutrals channel-mix skew.
func huePatchPixel(x int) color.RGBA {
	const patches = 6
	patch := x * patches / size
	hue := float64(patch) * 360.0 / patches
	r, g, b := hslToRGB(hue, 0.7, 0.5)
	return color.RGBA{R: r, G: g, B: b, A: 255}
}

// checkerPixel: bottom third — high-contrast alternating tile checkerboard.
// Exercises image.sharpen's edge response (the gap V-9 flagged: the
// existing gradient.jpg/png fixtures have no edges to sharpen).
func checkerPixel(x, y int) color.RGBA {
	if ((x/checkerTile)+(y/checkerTile))%2 == 0 {
		return color.RGBA{R: 20, G: 20, B: 20, A: 255}
	}
	return color.RGBA{R: 235, G: 235, B: 235, A: 255}
}

// hslToRGB is standard HSL->sRGB conversion (h in degrees 0..360, s/l in
// 0..1) used only to synthesize the hue-patch region above — not part of
// any production processor.
func hslToRGB(h, s, l float64) (r, g, b uint8) {
	c := (1 - math.Abs(2*l-1)) * s
	hp := h / 60
	x := c * (1 - math.Abs(math.Mod(hp, 2)-1))
	var r1, g1, b1 float64
	switch {
	case hp < 1:
		r1, g1, b1 = c, x, 0
	case hp < 2:
		r1, g1, b1 = x, c, 0
	case hp < 3:
		r1, g1, b1 = 0, c, x
	case hp < 4:
		r1, g1, b1 = 0, x, c
	case hp < 5:
		r1, g1, b1 = x, 0, c
	default:
		r1, g1, b1 = c, 0, x
	}
	m := l - c/2
	return toByte(r1 + m), toByte(g1 + m), toByte(b1 + m)
}

func toByte(v float64) uint8 {
	if v < 0 {
		v = 0
	}
	if v > 1 {
		v = 1
	}
	return uint8(v*255 + 0.5)
}
