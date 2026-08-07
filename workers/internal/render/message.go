// Package render executes a full Edit Recipe (an ordered list of processor
// steps) against a single source file and returns the final rendered
// output — the synchronous, single-image counterpart to the async
// per-step NATS dispatch loop in internal/dispatch, used by
// cmd/renderserver. See docs/tasks/TASK-editor-export.md.
package render

// RecipeStep is the JSON shape cmd/renderserver decodes an incoming
// recipe's steps into. Deliberately not shared with
// apps/web/src/lib/recipe/schema.ts's Zod type or the orchestrator's
// StepDto — same accepted hand-duplication as D-8/D-17 in
// docs/90-deferred-register.md, not a new debt shape. Params are validated
// by whichever processors.Func the step's Processor resolves to (the same
// validation the trusted NATS dispatch path already relies on), not
// re-validated here.
type RecipeStep struct {
	Processor string                 `json:"processor"`
	Params    map[string]interface{} `json:"params"`
}
