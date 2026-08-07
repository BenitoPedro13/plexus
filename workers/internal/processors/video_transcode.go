package processors

import (
	"context"
	"fmt"
)

const defaultVideoQuality = 75

// VideoTranscode implements the "video.transcode" processor. Params:
//
//	format: required, "mp4" or "webm". Fixes the video/audio codec pair
//	        (mp4 -> h264/aac, webm -> vp9/opus) — see
//	        docs/tasks/TASK-video-audio-processors.md "Porquê".
//	quality: optional, 1-100, default 75. Maps to the video codec's CRF via
//	         videoCrfArgs; audio is always re-encoded at a fixed 128k.
func VideoTranscode(ctx context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	format, err := requireStringParam(params, "format")
	if err != nil {
		return "", err
	}
	vcodec, acodec, ok := videoCodecsForContainer(format)
	if !ok {
		return "", fmt.Errorf("param %q must be one of mp4, webm, got %q", "format", format)
	}

	quality, err := optionalIntParamInRange(params, "quality", defaultVideoQuality, 1, 100)
	if err != nil {
		return "", err
	}

	out, err := outputPath(jobStepID, format)
	if err != nil {
		return "", err
	}

	args := append([]string{"-i", inputRef, "-c:v", vcodec}, videoCrfArgs(vcodec, quality)...)
	args = append(args, "-c:a", acodec, "-b:a", "128k", out)

	if err := runFFmpeg(ctx, args...); err != nil {
		return "", fmt.Errorf("transcode %q to %s: %w", inputRef, format, err)
	}

	return out, nil
}
