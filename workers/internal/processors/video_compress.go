package processors

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// VideoCompress implements the "video.compress" processor. Params:
//
//	quality: required, 1-100.
//
// "Compress never changes format" (same rule as image.compress): the
// container is read from inputRef's file extension — not ffprobe content
// inspection, deliberately, see
// docs/tasks/TASK-video-audio-processors.md "Porquê" — and re-encoded at
// the CRF for that container's standard codec pair (same table as
// VideoTranscode); anything other than .mp4/.webm is a validation error.
func VideoCompress(ctx context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	quality, err := requireIntParamInRange(params, "quality", 1, 100)
	if err != nil {
		return "", err
	}

	container := strings.ToLower(strings.TrimPrefix(filepath.Ext(inputRef), "."))
	vcodec, acodec, ok := videoCodecsForContainer(container)
	if !ok {
		return "", fmt.Errorf("input %q has unsupported container %q for compress (must be mp4 or webm)", inputRef, container)
	}

	out, err := outputPath(jobStepID, container)
	if err != nil {
		return "", err
	}

	args := append([]string{"-i", inputRef, "-c:v", vcodec}, videoCrfArgs(vcodec, quality)...)
	args = append(args, "-c:a", acodec, "-b:a", "128k", out)

	if err := runFFmpeg(ctx, args...); err != nil {
		return "", fmt.Errorf("compress %q: %w", inputRef, err)
	}

	return out, nil
}
