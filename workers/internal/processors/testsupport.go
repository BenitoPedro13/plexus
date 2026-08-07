package processors

import (
	"context"
	"os"
	"sync/atomic"
	"time"
)

// RegisterForTest registers fn under name, returning a restore func that
// puts back whatever was previously registered (or removes name entirely if
// nothing was). Exists so dispatch package tests
// (workers/internal/dispatch/dispatch_test.go) can exercise Handle() against
// a processor with a controlled, artificial duration -- e.g. to reliably
// cross a short test AckWait window -- without waiting on a real
// ffmpeg/libvips operation to naturally take that long. The registry is
// otherwise never mutated after startup; not for production use.
func RegisterForTest(name string, fn Func) (restore func()) {
	prev, had := registry[name]
	registry[name] = fn
	return func() {
		if had {
			registry[name] = prev
		} else {
			delete(registry, name)
		}
	}
}

// SlowNoopForTest returns a Func that sleeps for delay (simulating a
// long-running encode) before copying inputRef's bytes to a fresh output
// file via the same writeOutput helper every real processor uses. calls, if
// non-nil, is incremented (atomically -- may run concurrently with itself if
// a bug causes duplicate delivery) on each invocation, so a test can assert
// how many times the processor actually ran.
func SlowNoopForTest(delay time.Duration, calls *int32) Func {
	return func(_ context.Context, jobStepID, inputRef string, _ map[string]interface{}) (string, error) {
		if calls != nil {
			atomic.AddInt32(calls, 1)
		}
		time.Sleep(delay)
		data, err := os.ReadFile(inputRef)
		if err != nil {
			return "", err
		}
		return writeOutput(jobStepID, "bin", data)
	}
}
