package processors_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestVideoCompress(t *testing.T) {
	t.Run("compresses mp4 keeping h264/aac", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.VideoCompress(context.Background(), "step-mp4", fixtureMP4, map[string]interface{}{
			"quality": float64(50),
		})
		if err != nil {
			t.Fatalf("VideoCompress: %v", err)
		}

		if filepath.Ext(outputRef) != ".mp4" {
			t.Fatalf("expected .mp4 output, got %q", outputRef)
		}
		streams := ffprobeStreams(t, outputRef)
		if !hasStream(streams, "video", "h264") {
			t.Fatalf("expected h264 video stream, got %+v", streams)
		}
		if !hasStream(streams, "audio", "aac") {
			t.Fatalf("expected aac audio stream, got %+v", streams)
		}
	})

	t.Run("compresses webm keeping vp9/opus", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.VideoCompress(context.Background(), "step-webm", fixtureWebM, map[string]interface{}{
			"quality": float64(50),
		})
		if err != nil {
			t.Fatalf("VideoCompress: %v", err)
		}

		streams := ffprobeStreams(t, outputRef)
		if !hasStream(streams, "video", "vp9") {
			t.Fatalf("expected vp9 video stream, got %+v", streams)
		}
		if !hasStream(streams, "audio", "opus") {
			t.Fatalf("expected opus audio stream, got %+v", streams)
		}
	})

	t.Run("missing quality is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.VideoCompress(context.Background(), "step", fixtureMP4, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing quality, got nil")
		}
	})

	t.Run("unsupported container is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.VideoCompress(context.Background(), "step", fixtureMP3, map[string]interface{}{
			"quality": float64(50),
		}); err == nil {
			t.Fatal("expected error for unsupported container, got nil")
		}
	})
}
