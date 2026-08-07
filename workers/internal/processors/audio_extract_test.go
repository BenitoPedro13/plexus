package processors_test

import (
	"context"
	"strings"
	"testing"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestAudioExtract(t *testing.T) {
	for _, tc := range []struct {
		format string
		codec  string
	}{
		{"mp3", "mp3"},
		{"aac", "aac"},
		{"opus", "opus"},
	} {
		t.Run(tc.format, func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			outputRef, err := processors.AudioExtract(context.Background(), "step-"+tc.format, fixtureMP4, map[string]interface{}{
				"format": tc.format,
			})
			if err != nil {
				t.Fatalf("AudioExtract: %v", err)
			}

			streams := ffprobeStreams(t, outputRef)
			if !hasStream(streams, "audio", tc.codec) {
				t.Fatalf("expected %s audio stream, got %+v", tc.codec, streams)
			}
			if hasStream(streams, "video", "h264") || hasStream(streams, "video", "vp9") {
				t.Fatalf("expected no video stream in extracted audio, got %+v", streams)
			}
		})
	}

	t.Run("respects an explicit bitrate param", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.AudioExtract(context.Background(), "step-bitrate", fixtureMP4, map[string]interface{}{
			"format":  "mp3",
			"bitrate": float64(64),
		})
		if err != nil {
			t.Fatalf("AudioExtract: %v", err)
		}
		if !hasStream(ffprobeStreams(t, outputRef), "audio", "mp3") {
			t.Fatal("expected mp3 audio stream")
		}
	})

	t.Run("missing format is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AudioExtract(context.Background(), "step", fixtureMP4, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing format, got nil")
		}
	})

	t.Run("wav is not a supported extract format", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AudioExtract(context.Background(), "step", fixtureMP4, map[string]interface{}{
			"format": "wav",
		}); err == nil {
			t.Fatal("expected error for wav format, got nil")
		}
	})

	t.Run("bitrate out of range is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AudioExtract(context.Background(), "step", fixtureMP4, map[string]interface{}{
			"format":  "mp3",
			"bitrate": float64(16),
		}); err == nil {
			t.Fatal("expected error for out-of-range bitrate, got nil")
		}
	})

	t.Run("nonexistent input is an error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AudioExtract(context.Background(), "step", "/nonexistent/does-not-exist.mp4", map[string]interface{}{
			"format": "mp3",
		}); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})

	t.Run("input with no audio stream is a clear error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		_, err := processors.AudioExtract(context.Background(), "step", fixtureNoAudio, map[string]interface{}{
			"format": "mp3",
		})
		if err == nil {
			t.Fatal("expected error for input with no audio stream, got nil")
		}
		if !strings.Contains(err.Error(), "no audio stream") {
			t.Fatalf("expected error to mention \"no audio stream\", got: %v", err)
		}
	})
}
