package processors_test

import (
	"encoding/json"
	"os/exec"
	"testing"
)

// ffprobeStream is the subset of ffprobe's per-stream JSON output the media
// processor tests assert on — codec identity, not byte-equality (encoders
// aren't guaranteed deterministic across ffmpeg builds/versions).
type ffprobeStream struct {
	CodecName string `json:"codec_name"`
	CodecType string `json:"codec_type"`
}

// ffprobeStreams runs ffprobe against path and returns its streams. Used by
// video/audio processor tests to assert on the output's actual codecs
// rather than trusting the processor's own claims about what it wrote.
func ffprobeStreams(t *testing.T, path string) []ffprobeStream {
	t.Helper()

	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %q: %v", path, err)
	}

	var parsed struct {
		Streams []ffprobeStream `json:"streams"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse ffprobe output for %q: %v", path, err)
	}
	return parsed.Streams
}

// hasStream reports whether streams contains one of the given codecType
// (e.g. "video", "audio") encoded with codecName.
func hasStream(streams []ffprobeStream, codecType, codecName string) bool {
	for _, s := range streams {
		if s.CodecType == codecType && s.CodecName == codecName {
			return true
		}
	}
	return false
}
