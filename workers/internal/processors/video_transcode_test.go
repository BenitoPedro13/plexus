package processors_test

import (
	"context"
	"testing"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// tiny.mp4 / tiny.webm are 32x32, 0.5s committed fixtures — see
// docs/tasks/TASK-video-audio-processors.md.
const (
	fixtureMP4  = "../../testdata/media/tiny.mp4"
	fixtureWebM = "../../testdata/media/tiny.webm"
	fixtureMP3  = "../../testdata/media/tiny.mp3"
)

func TestVideoTranscode(t *testing.T) {
	t.Run("to mp4 produces h264/aac", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.VideoTranscode(context.Background(), "step-mp4", fixtureWebM, map[string]interface{}{
			"format": "mp4",
		})
		if err != nil {
			t.Fatalf("VideoTranscode: %v", err)
		}

		streams := ffprobeStreams(t, outputRef)
		if !hasStream(streams, "video", "h264") {
			t.Fatalf("expected h264 video stream, got %+v", streams)
		}
		if !hasStream(streams, "audio", "aac") {
			t.Fatalf("expected aac audio stream, got %+v", streams)
		}
	})

	t.Run("to webm produces vp9/opus", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.VideoTranscode(context.Background(), "step-webm", fixtureMP4, map[string]interface{}{
			"format": "webm",
		})
		if err != nil {
			t.Fatalf("VideoTranscode: %v", err)
		}

		streams := ffprobeStreams(t, outputRef)
		if !hasStream(streams, "video", "vp9") {
			t.Fatalf("expected vp9 video stream, got %+v", streams)
		}
		if !hasStream(streams, "audio", "opus") {
			t.Fatalf("expected opus audio stream, got %+v", streams)
		}
	})

	t.Run("respects an explicit quality param", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		outputRef, err := processors.VideoTranscode(context.Background(), "step-quality", fixtureMP4, map[string]interface{}{
			"format":  "mp4",
			"quality": float64(40),
		})
		if err != nil {
			t.Fatalf("VideoTranscode: %v", err)
		}
		if !hasStream(ffprobeStreams(t, outputRef), "video", "h264") {
			t.Fatal("expected h264 video stream")
		}
	})

	t.Run("missing format is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.VideoTranscode(context.Background(), "step", fixtureMP4, map[string]interface{}{}); err == nil {
			t.Fatal("expected error for missing format, got nil")
		}
	})

	t.Run("unsupported format is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.VideoTranscode(context.Background(), "step", fixtureMP4, map[string]interface{}{
			"format": "avi",
		}); err == nil {
			t.Fatal("expected error for unsupported format, got nil")
		}
	})

	t.Run("quality out of range is a validation error", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.VideoTranscode(context.Background(), "step", fixtureMP4, map[string]interface{}{
			"format":  "mp4",
			"quality": float64(0),
		}); err == nil {
			t.Fatal("expected error for out-of-range quality, got nil")
		}
	})

	t.Run("nonexistent input file is an error, not a panic", func(t *testing.T) {
		t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

		if _, err := processors.VideoTranscode(context.Background(), "step", "/nonexistent/does-not-exist.mp4", map[string]interface{}{
			"format": "mp4",
		}); err == nil {
			t.Fatal("expected error for nonexistent input, got nil")
		}
	})
}
