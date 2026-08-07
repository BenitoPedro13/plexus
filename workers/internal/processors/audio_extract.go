package processors

import (
	"context"
	"fmt"
)

const (
	defaultAudioBitrate = 128
	minAudioBitrate     = 32
	maxAudioBitrate     = 320
)

// AudioExtract implements the "audio.extract" processor. Params:
//
//	format: required, "mp3", "aac", or "opus".
//	bitrate: optional, 32-320 (kbps), default 128.
//
// Takes any input with an audio stream (typically a video file) and writes
// an audio-only output — -vn -map 0:a:0 explicitly drops any video/
// attached-picture streams rather than relying on ffmpeg's default stream
// selection.
func AudioExtract(ctx context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	format, err := requireStringParam(params, "format")
	if err != nil {
		return "", err
	}
	codec, ok := audioCodecForFormat(format)
	if !ok || format == "wav" {
		return "", fmt.Errorf("param %q must be one of mp3, aac, opus, got %q", "format", format)
	}

	bitrate, err := optionalIntParamInRange(params, "bitrate", defaultAudioBitrate, minAudioBitrate, maxAudioBitrate)
	if err != nil {
		return "", err
	}

	out, err := outputPath(jobStepID, format)
	if err != nil {
		return "", err
	}

	if err := runFFmpeg(ctx, "-i", inputRef, "-vn", "-map", "0:a:0", "-c:a", codec, "-b:a", fmt.Sprintf("%dk", bitrate), out); err != nil {
		if isNoAudioStreamError(err) {
			return "", fmt.Errorf("input %q has no audio stream to extract: %w", inputRef, err)
		}
		return "", fmt.Errorf("extract audio from %q as %s: %w", inputRef, format, err)
	}

	return out, nil
}
