// Package processors implements the Phase 1 built-in processors
// (image.resize, image.convert, image.compress, video.transcode,
// video.compress, audio.extract, audio.convert) that
// workers/internal/dispatch/handler.go dispatches StepDispatchMessage.Processor
// to. See docs/tasks/TASK-builtin-processors.md and
// docs/tasks/TASK-video-audio-processors.md.
package processors

import "context"

// Func processes the file at inputRef per params and returns the path to the
// output file it wrote. jobStepID names the output file (see
// writeOutput) — it is dispatch metadata, not a pipeline param, so it's
// passed separately rather than smuggled into params. A non-nil error means
// the step failed — the caller (dispatch.Handle) turns that into a
// StepResultFailed, never a panic or a dropped message.
type Func func(ctx context.Context, jobStepID, inputRef string, params map[string]interface{}) (outputRef string, err error)

var registry = map[string]Func{
	"image.resize":    Resize,
	"image.convert":   Convert,
	"image.compress":  Compress,
	"video.transcode": VideoTranscode,
	"video.compress":  VideoCompress,
	"audio.extract":   AudioExtract,
	"audio.convert":   AudioConvert,
}

// Lookup returns the processor registered for name, if any.
func Lookup(name string) (Func, bool) {
	fn, ok := registry[name]
	return fn, ok
}
