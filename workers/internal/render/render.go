package render

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// RunRecipe executes steps against sourcePath in order, feeding each step's
// output in as the next step's input (the first step reads sourcePath
// itself). An empty steps list is a valid no-op recipe (mirrors
// apps/web/src/lib/recipe/schema.ts's Recipe.steps being optional/empty)
// and returns sourcePath unchanged, with a no-op cleanup.
//
// Each step gets a synthetic jobStepID derived from renderID (which the
// caller must make unique per render, e.g. via a fresh uuid) rather than a
// real Postgres job-step id — processors.Func only uses it to name its
// output file (processors/output.go's outputPath), and a renderID-derived
// id is sufficient to avoid collisions with concurrent renders sharing the
// same WORKER_STORAGE_DIR, the same way concurrent worker replicas already
// share it safely today via each job step's own unique id. Deliberately
// does *not* give each render its own temp directory: processors.Func
// resolves WORKER_STORAGE_DIR itself via os.Getenv (processors/output.go),
// a process-global read — mutating that env var per HTTP request would
// race under concurrent renders, so this leans on per-step id uniqueness
// instead, not a per-request directory.
//
// The returned cleanup removes every file this call wrote (all
// intermediate outputs, including the final one) — callers must read the
// result before calling it. sourcePath itself is never removed; it's the
// caller's own input, not something RunRecipe created.
func RunRecipe(ctx context.Context, renderID, sourcePath string, steps []RecipeStep) (outputPath string, cleanup func(), err error) {
	var created []string
	cleanup = func() {
		for _, p := range created {
			_ = os.Remove(p)
		}
	}

	current := sourcePath
	for i, step := range steps {
		fn, ok := processors.Lookup(step.Processor)
		if !ok {
			cleanup()
			return "", func() {}, fmt.Errorf("step %d: unknown processor %q", i, step.Processor)
		}

		stepID := fmt.Sprintf("render-%s-%d", renderID, i)
		out, err := fn(ctx, stepID, current, step.Params)
		if err != nil {
			cleanup()
			return "", func() {}, fmt.Errorf("step %d (%s): %w", i, step.Processor, err)
		}

		created = append(created, out)
		current = out
	}

	return current, cleanup, nil
}

// NewRenderID returns a fresh identifier suitable for RunRecipe's renderID
// parameter — a thin wrapper so callers (cmd/renderserver) don't need their
// own uuid import just for this one call site.
func NewRenderID() string {
	return uuid.NewString()
}
