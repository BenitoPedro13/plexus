package processors_test

import (
	"os"
	"testing"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

func TestMain(m *testing.M) {
	if err := processors.Startup(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
