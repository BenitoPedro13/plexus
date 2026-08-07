package processors_test

import (
	"testing"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestLookup(t *testing.T) {
	for _, id := range []string{"image.resize", "image.convert", "image.compress"} {
		if _, ok := processors.Lookup(id); !ok {
			t.Errorf("expected processor %q to be registered", id)
		}
	}

	if _, ok := processors.Lookup("image.watermark"); ok {
		t.Error("expected unregistered processor id to return ok=false")
	}
}
