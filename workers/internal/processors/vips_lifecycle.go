package processors

import "github.com/davidbyttow/govips/v2/vips"

// Startup initializes libvips once per process. Must be called before any
// processor runs (cmd/worker/main.go calls it once at boot); govips is safe
// for concurrent use by multiple goroutines after that, so it is not called
// per-job. A non-nil error means the worker cannot process any image job and
// should not start.
func Startup() error {
	return vips.Startup(nil)
}

// Shutdown releases libvips resources. Called once via defer in main().
func Shutdown() {
	vips.Shutdown()
}
