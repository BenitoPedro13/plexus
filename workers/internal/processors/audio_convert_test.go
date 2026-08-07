package processors_test

import (
	"context"
	"testing"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestAudioConvert(t *testing.T) {
	for _, tc := range []struct {
		format string
		codec  string
	}{
		{"mp3", "mp3"},
		{"aac", "aac"},
		{"opus", "opus"},
		{"wav", "pcm_s16le"},
	} {
		t.Run(tc.format, func(t *testing.T) {
			t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

			outputRef, err := processors.AudioConvert(context.Background(), "step-"+tc.format, fixtureMP3, map[string]interface{}{
				"format": tc.format,
			})
			if err != nil {
				t.Fatalf("AudioConvert: %v", err)
			}

			streams := ffprobeStreams(t, outputRef)
			if !hasStream(streams, "audio", tc.codec) {
				t.Fatalf("expected %s audio stream, got %+v", tc.codec, streams)
			}
		})
	}

	t.Run("bitrate param is accepted but has no effect on wav", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.AudioConvert(context.Background(), "step-wav-bitrate", fixtureMP3, map[string]interface{}{
			"format":  "wav",
			"bitrate": float64(64),
		})
		if err != nil {
			t.Fatalf("AudioConvert: %v", err)
		}
		if !hasStream(ffprobeStreams(t, outputRef), "audio", "pcm_s16le") {
			t.Fatal("expected pcm_s16le audio stream")
		}
	})

	t.Run("missing format is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AudioConvert(context.Background(), "step", fixtureMP3, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing format, got nil")
		}
	})

	t.Run("unsupported format is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.AudioConvert(context.Background(), "step", fixtureMP3, map[string]interface{}{
			"format": "flac",
		}); err == nil {
			t.Fatal("expected error for unsupported format, got nil")
		}
	})
}
