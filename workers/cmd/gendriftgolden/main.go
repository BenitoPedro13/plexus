// Command gendriftgolden runs the real composite processors
// (processors.AdjustLight/AdjustColor/BlackAndWhite/Sharpen — unmodified,
// same code path the worker runs in production) against
// testdata/drift/source.png at a fixed set of representative param points,
// then dumps every pixel of the source and each result as raw RGBA8 via
// govips's img.GetPoint. Golden fixtures for
// docs/tasks/TASK-recipe-fidelity-drift.md's drift measurement. Run
// manually:
//
//	go run ./cmd/gendriftgolden
//
// Not part of `go test` or CI — its output is committed and only
// regenerated deliberately.
package main

import (
	"context"
	"encoding/binary"
	"log"
	"os"
	"path/filepath"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

const (
	sourcePath = "../testdata/drift/source.png"
	outputDir  = "../testdata/drift"
	goldenDir  = "../testdata/drift/golden"
)

type point struct {
	name   string
	params map[string]interface{}
}

var goldenPoints = []struct {
	processor string
	fn        processors.Func
	points    []point
}{
	{
		processor: "image.adjustLight",
		fn:        processors.AdjustLight,
		points: []point{
			{"light-mild", map[string]interface{}{"exposure": 0.5, "brightness": 0.1, "contrast": 0.2, "blackPoint": 0.05}},
			{"light-strong", map[string]interface{}{"exposure": -0.5, "brightness": -0.2, "contrast": 0.3, "blackPoint": 0.1}},
		},
	},
	{
		processor: "image.adjustColor",
		fn:        processors.AdjustColor,
		points: []point{
			{"color-sat-0.5", map[string]interface{}{"saturation": 0.5}},
			{"color-sat-neg0.5", map[string]interface{}{"saturation": -0.5}},
			{"color-sat-1.0", map[string]interface{}{"saturation": 1.0}},
		},
	},
	{
		processor: "image.blackAndWhite",
		fn:        processors.BlackAndWhite,
		points: []point{
			{"bw-full", map[string]interface{}{"intensity": 1.0, "neutrals": 0.0, "tone": 0.0}},
			{"bw-skewed", map[string]interface{}{"intensity": 0.6, "neutrals": 0.5, "tone": -0.3}},
		},
	},
	{
		processor: "image.sharpen",
		fn:        processors.Sharpen,
		points: []point{
			{"sharpen-0.3", map[string]interface{}{"intensity": 0.3}},
			{"sharpen-1.0", map[string]interface{}{"intensity": 1.0}},
		},
	},
	{
		// V-2's scope explicitly excluded image.resize ("different mechanism --
		// geometry vs. per-pixel color"). TASK-resize-drift.md (V-6) measures
		// it separately: govips's Thumbnail() resamples with Lanczos3 (confirmed
		// against libvips/resample/resize.c's vips_resize_class_init default),
		// while the live preview's GPU texture sampler is hardware bilinear --
		// a real algorithmic difference, not a rounding gap. dumpRGBA already
		// reads width/height off the actual output image, so resize's varying
		// output dimensions need no special handling below.
		processor: "image.resize",
		fn:        processors.Resize,
		points: []point{
			{"resize-inside-half", map[string]interface{}{"width": 64.0, "height": 64.0, "fit": "inside"}},
			{"resize-cover-crop", map[string]interface{}{"width": 96.0, "height": 48.0, "fit": "cover"}},
			{"resize-inside-upscale", map[string]interface{}{"width": 192.0, "height": 192.0, "fit": "inside"}},
		},
	},
}

func main() {
	if err := processors.Startup(); err != nil {
		log.Fatalf("start libvips: %v", err)
	}
	defer processors.Shutdown()

	storageDir, err := os.MkdirTemp("", "gendriftgolden-*")
	if err != nil {
		log.Fatalf("mkdtemp: %v", err)
	}
	defer func() {
		if err := os.RemoveAll(storageDir); err != nil {
			log.Printf("cleanup %q: %v", storageDir, err)
		}
	}()
	if err := os.Setenv("WORKER_STORAGE_DIR", storageDir); err != nil {
		log.Fatalf("setenv: %v", err)
	}

	if err := os.MkdirAll(goldenDir, 0o755); err != nil {
		log.Fatalf("mkdir %q: %v", goldenDir, err)
	}

	dumpRGBA(sourcePath, filepath.Join(outputDir, "source.rgba"))

	ctx := context.Background()
	for _, group := range goldenPoints {
		for _, pt := range group.points {
			outputRef, err := group.fn(ctx, "gendriftgolden-"+pt.name, sourcePath, pt.params)
			if err != nil {
				log.Fatalf("%s (%s): %v", group.processor, pt.name, err)
			}
			dumpRGBA(outputRef, filepath.Join(goldenDir, pt.name+".rgba"))
		}
	}
}

// dumpRGBA loads path via govips, reads every pixel with img.GetPoint, and
// writes an 8-byte header (width uint32LE, height uint32LE) followed by
// width*height*4 raw RGBA8 bytes, row-major, to destPath.
func dumpRGBA(path, destPath string) {
	img, err := vips.NewImageFromFile(path)
	if err != nil {
		log.Fatalf("load %q: %v", path, err)
	}
	defer img.Close()

	width, height := img.Width(), img.Height()
	buf := make([]byte, 8+width*height*4)
	binary.LittleEndian.PutUint32(buf[0:4], uint32(width))
	binary.LittleEndian.PutUint32(buf[4:8], uint32(height))

	hasAlpha := img.HasAlpha()
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			px, err := img.GetPoint(x, y)
			if err != nil {
				log.Fatalf("get point (%d,%d) in %q: %v", x, y, path, err)
			}
			off := 8 + (y*width+x)*4
			buf[off+0] = clampByte(px[0])
			buf[off+1] = clampByte(px[1])
			buf[off+2] = clampByte(px[2])
			if hasAlpha && len(px) > 3 {
				buf[off+3] = clampByte(px[3])
			} else {
				buf[off+3] = 255
			}
		}
	}

	if err := os.WriteFile(destPath, buf, 0o644); err != nil {
		log.Fatalf("write %q: %v", destPath, err)
	}
	log.Printf("wrote %s (%dx%d)", destPath, width, height)
}

func clampByte(v float64) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v + 0.5)
}
