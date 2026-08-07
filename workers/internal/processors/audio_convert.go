package processors

import (
	"context"
	"fmt"
)

// AudioConvert implements the "audio.convert" processor. Params:
//
//	format: required, one of "mp3", "aac", "opus", "wav".
//	bitrate: optional, 32-320 (kbps), default 128. Ignored for wav (lossless
//	         PCM has no bitrate knob — same "some formats have no such
//	         param" shape as image.convert's png quality).
func AudioConvert(ctx context.Context, jobStepID, inputRef string, params map[string]interface{}) (string, error) {
	format, err := requireStringParam(params, "format")
	if err != nil {
		return "", err
	}
	codec, ok := audioCodecForFormat(format)
	if !ok {
		return "", fmt.Errorf("param %q must be one of mp3, aac, opus, wav, got %q", "format", format)
	}

	bitrate, err := optionalIntParamInRange(params, "bitrate", defaultAudioBitrate, minAudioBitrate, maxAudioBitrate)
	if err != nil {
		return "", err
	}

	out, err := outputPath(jobStepID, format)
	if err != nil {
		return "", err
	}

	args := []string{"-i", inputRef, "-vn", "-map", "0:a:0", "-c:a", codec}
	if format != "wav" {
		args = append(args, "-b:a", fmt.Sprintf("%dk", bitrate))
	}
	args = append(args, out)

	if err := runFFmpeg(ctx, args...); err != nil {
		if isNoAudioStreamError(err) {
			return "", fmt.Errorf("input %q has no audio stream to convert: %w", inputRef, err)
		}
		return "", fmt.Errorf("convert %q to %s: %w", inputRef, format, err)
	}

	return out, nil
}
