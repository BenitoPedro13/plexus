package processors

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// noAudioStreamMarker is the stderr ffmpeg emits when an explicit "-map
// 0:a:0" (used by audio.extract/audio.convert to select the first audio
// stream) matches nothing because the input has no audio stream at all.
// ffmpeg rejects the map before it even opens the input, so this is
// reliably distinguishable from other option-parse failures by this exact
// wording rather than by exit code (234 is ffmpeg's generic "bad option"
// code, not specific to this case).
const noAudioStreamMarker = "Stream map '' matches no streams"

// isNoAudioStreamError reports whether err (as returned by runFFmpeg) is
// ffmpeg failing to satisfy an explicit "-map 0:a:0" because the input has
// no audio stream — the raw message is accurate but reads as an ffmpeg
// CLI-syntax error ("Stream map ”", "add a trailing '?'") rather than
// "this input has no audio", so callers translate it into a clear domain
// error instead of letting it reach job-failure output verbatim.
func isNoAudioStreamError(err error) bool {
	return err != nil && strings.Contains(err.Error(), noAudioStreamMarker)
}

// runFFmpeg runs the ffmpeg binary with args, always prepending flags that
// keep it non-interactive and quiet on success: -nostdin (never block
// waiting for a terminal), -hide_banner -loglevel error (only emit output on
// failure), -y (overwrite outputPath() targets — jobStepID-named paths are
// meant to be written exactly once per job, but re-running a failed step
// must not fail on "file exists"). args are passed as separate argv
// elements to exec.CommandContext, never concatenated into a shell string,
// so there is no injection surface from inputRef/outputRef/param-derived
// values.
func runFFmpeg(ctx context.Context, args ...string) error {
	full := append([]string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y"}, args...)

	cmd := exec.CommandContext(ctx, "ffmpeg", full...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// CheckAvailable verifies the ffmpeg binary is on PATH. Called once at
// worker startup (cmd/worker/main.go), not per-job — fail fast if it's
// missing rather than surfacing it as a confusing first-job failure.
func CheckAvailable() error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return fmt.Errorf("ffmpeg not found on PATH: %w", err)
	}
	return nil
}

// videoCodecsForContainer maps a video container id to its fixed
// video/audio codec pair — the pairs this slice's processors actually need
// (spec P0: video transcode/compress), not ffmpeg's full encoder surface.
// See docs/tasks/TASK-video-audio-processors.md "Porquê".
func videoCodecsForContainer(container string) (vcodec, acodec string, ok bool) {
	switch container {
	case "mp4":
		return "libx264", "aac", true
	case "webm":
		return "libvpx-vp9", "libopus", true
	default:
		return "", "", false
	}
}

// audioCodecForFormat maps an audio format id to its ffmpeg encoder name.
func audioCodecForFormat(format string) (codec string, ok bool) {
	switch format {
	case "mp3":
		return "libmp3lame", true
	case "aac":
		return "aac", true
	case "opus":
		return "libopus", true
	case "wav":
		return "pcm_s16le", true
	default:
		return "", false
	}
}

// videoEncodeArgs returns the ffmpeg flags for a codec-specific quality
// (1-100) as a CRF value, plus (for libvpx-vp9) the multithreading flags
// needed to actually use more than ~1 core. This is a documented
// linear-mapping judgment call for the CRF part, same shape as
// pngCompressionFromQuality in format.go — x264 and VP9 use different CRF
// scales (0-51 vs 0-63), so there is no single formula. See
// docs/tasks/TASK-video-audio-processors.md "Porquê" and
// docs/tasks/TASK-vp9-encode-threading.md.
func videoEncodeArgs(vcodec string, quality int) []string {
	switch vcodec {
	case "libx264":
		crf := 51 - (quality*51)/100
		if crf < 0 {
			crf = 0
		}
		if crf > 51 {
			crf = 51
		}
		// libx264 auto-detects and uses all available cores by default —
		// no explicit threading flags needed here.
		return []string{"-crf", strconv.Itoa(crf)}
	case "libvpx-vp9":
		crf := 63 - (quality*63)/100
		if crf < 0 {
			crf = 0
		}
		if crf > 63 {
			crf = 63
		}
		// -b:v 0 is required for libvpx-vp9 to honor -crf as true constant
		// quality mode; without it the encoder ignores -crf and falls back
		// to its default bitrate-target mode. See "Porquê" (V-3).
		//
		// -row-mt 1 and -tile-columns 2 are threading-only flags (no
		// quality/size cost — see TASK-vp9-encode-threading.md's benchmark):
		// libvpx-vp9 defaults to effectively single-threaded encoding
		// (`ffmpeg -h encoder=libvpx-vp9` reports -row-mt default "auto",
		// which resolves to off in practice) regardless of -threads, so
		// without them one core does nearly all the work no matter how many
		// are available. -threads sizes the encoder's thread pool to the
		// host's logical CPUs.
		return []string{
			"-crf", strconv.Itoa(crf), "-b:v", "0",
			"-row-mt", "1",
			"-tile-columns", "2",
			"-threads", strconv.Itoa(runtime.NumCPU()),
		}
	default:
		return nil
	}
}
