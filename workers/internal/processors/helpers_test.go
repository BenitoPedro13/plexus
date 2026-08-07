package processors_test

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"
)

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %q: %v", path, err)
	}
	return info.Size()
}

// imageAverage loads path and returns govips's Average() (mean pixel value
// across all bands) — used by the composite-processor tests to assert
// directional effects (brighter/darker/more-or-less-saturated) on the
// actual encoded-and-reloaded output rather than predicting exact values
// through a lossy JPEG/PNG round-trip.
func imageAverage(t *testing.T, path string) float64 {
	t.Helper()
	img, err := vips.NewImageFromFile(path)
	if err != nil {
		t.Fatalf("load %q: %v", path, err)
	}
	defer img.Close()

	avg, err := img.Average()
	if err != nil {
		t.Fatalf("average %q: %v", path, err)
	}
	return avg
}

// channelSpread loads the pixel at (x, y) in path and returns max-min
// across its bands — 0 for a perfectly gray/desaturated pixel, larger for
// more saturated/colorful pixels. Used by adjustColor/blackAndWhite tests.
func channelSpread(t *testing.T, path string, x, y int) float64 {
	t.Helper()
	img, err := vips.NewImageFromFile(path)
	if err != nil {
		t.Fatalf("load %q: %v", path, err)
	}
	defer img.Close()

	px, err := img.GetPoint(x, y)
	if err != nil {
		t.Fatalf("get point (%d,%d) in %q: %v", x, y, path, err)
	}

	min, max := px[0], px[0]
	for _, v := range px {
		if v < min {
			min = v
		}
		if v > max {
			max = v
		}
	}
	return max - min
}

// bytesEqual reports whether the files at a and b have identical contents —
// used to assert determinism (same params + same input => byte-identical
// output), a stronger check than the directional/property assertions the
// other helpers here make, valid here specifically because grain's noise
// generator is seeded (grainNoiseSeed) rather than genuinely random.
func bytesEqual(t *testing.T, a, b string) bool {
	t.Helper()
	dataA, err := os.ReadFile(a)
	if err != nil {
		t.Fatalf("read %q: %v", a, err)
	}
	dataB, err := os.ReadFile(b)
	if err != nil {
		t.Fatalf("read %q: %v", b, err)
	}
	return bytes.Equal(dataA, dataB)
}

// sampledVariance loads path and returns the sample variance of the
// mean-across-bands pixel value over a fixed grid of points spanning the
// image — a coarse noise-level proxy built from the same GetPoint primitive
// channelSpread already uses, avoiding the need for a new govips
// Deviate/stddev wrapper just for this test. Used by the grain tests to
// assert grain measurably increases pixel-to-pixel variance.
func sampledVariance(t *testing.T, path string) float64 {
	t.Helper()
	img, err := vips.NewImageFromFile(path)
	if err != nil {
		t.Fatalf("load %q: %v", path, err)
	}
	defer img.Close()

	const gridX, gridY = 8, 6
	w, h := img.Width(), img.Height()

	var samples []float64
	for gy := 0; gy < gridY; gy++ {
		y := (gy + 1) * h / (gridY + 1)
		for gx := 0; gx < gridX; gx++ {
			x := (gx + 1) * w / (gridX + 1)
			px, err := img.GetPoint(x, y)
			if err != nil {
				t.Fatalf("get point (%d,%d) in %q: %v", x, y, path, err)
			}
			var sum float64
			for _, v := range px {
				sum += v
			}
			samples = append(samples, sum/float64(len(px)))
		}
	}

	var mean float64
	for _, s := range samples {
		mean += s
	}
	mean /= float64(len(samples))

	var variance float64
	for _, s := range samples {
		d := s - mean
		variance += d * d
	}
	return variance / float64(len(samples))
}

// writeUniformRGBAPNG creates a small solid-color RGBA PNG fixture in dir
// (PNG, not JPEG, since JPEG has no alpha channel) and returns its path.
func writeUniformRGBAPNG(t *testing.T, dir string, r, g, b, a uint8) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{R: r, G: g, B: b, A: a})
		}
	}
	path := filepath.Join(dir, "uniform-rgba.png")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %q: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	if err := png.Encode(f, img); err != nil {
		t.Fatalf("encode %q: %v", path, err)
	}
	return path
}

// writeUniformJPEG creates a small solid-color JPEG fixture in dir and
// returns its path. testdata/images/gradient.jpg's L* range (~54-62, per
// TASK-highlights-shadows-tonelut.md's investigation) never dips below
// libvips tonelut's default mid-point (Lm=50), so it can't exercise the
// "shadows" bump (shad(x) is 0 for x>=Lm) — a synthetic uniform fixture at
// a chosen brightness is needed instead to land solidly in shadow or
// highlight territory.
func writeUniformJPEG(t *testing.T, dir string, r, g, b uint8) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{R: r, G: g, B: b, A: 255})
		}
	}
	path := filepath.Join(dir, "uniform.jpg")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %q: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatalf("encode %q: %v", path, err)
	}
	return path
}
