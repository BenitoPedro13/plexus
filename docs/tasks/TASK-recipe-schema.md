# TASK-recipe-schema — Edit Recipe data model for the editor (Phase 2)

## Cenário actual

Phase 1 already has a working notion of "an ordered list of processor steps," but it
exists only on the orchestrator side and only for pipelines:

- `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts` — `StepDto { id, processor,
  params: Record<string, unknown>, dependsOn?: string[] }`, validated with
  `class-validator`. `BUILTIN_PROCESSORS` is a flat string union of the seven Phase 1
  processor ids (`image.resize`, `image.convert`, `image.compress`, `video.transcode`,
  `video.compress`, `audio.extract`, `audio.convert`).
- `apps/orchestrator/src/db/schema.ts` — `PipelineStepDefinition` (same shape, persisted as
  `jsonb`), plus `jobSteps.params` as an untyped `jsonb` column.
- `apps/orchestrator/src/pipelines/linear-dag.validator.ts` — `resolveLinearOrder()`
  enforces Phase 1's "linear pipelines only" rule (single chain, one root, no branching)
  and returns steps in execution order.
- Go worker param contracts exist only as doc comments on each processor function, not as
  a shared schema: `image.resize` (`width`, `height` required positive ints; `fit`
  optional `"inside"`/`"cover"`, default `"inside"`), `image.convert` (`format` required
  one of `jpeg`/`png`/`webp`/`avif`; `quality` optional 1–100, default 85, ignored for
  png), `image.compress` (`quality` required 1–100, format is re-derived from the input,
  never changed).

`apps/web` (scaffolded in `TASK-editor-scaffold.md`) has no data model at all yet — just
the default `create-next-app` shell (`apps/web/src/app/{layout,page}.tsx`). There is no
TypeScript representation anywhere of an **Edit Recipe** (spec "Core Concepts": "a small,
ordered list of `{ processor, params }` entries — structurally identical to a Plexus
pipeline"), and nothing enforces that identity today beyond the two shapes happening to
look similar by hand.

`packages/` does not exist yet. `docs/90-deferred-register.md` D-1 explicitly named "the
Edit Recipe / Pipeline schema" as `packages/`'s own trigger, but qualified it "likely
Phase 3" — written before Phase 2 was scoped in detail. Phase 2 per the spec's phasing is
"recipe model, WebGL live preview, curated composite sliders, export — **no batch
integration yet**"; the orchestrator doesn't consume editor recipes until Phase 3's "Apply
to Batch." So today there is still only one real consumer of a recipe type: `apps/web`.

## Mudanças planeadas

Scope is the **data model only** — the ordered `{ processor, params }[]` structure, typed
per-processor params, parsing/validation, and serialization. Explicitly **not** in scope:

- Composite-slider → parameter mapping (Light/Color/B&W/Sharpen) — that's `D-6`, its own
  design task, because it needs new processor ids/params that don't exist in the Go
  workers yet (crop, tonal/color adjustments). This task only models the three processors
  that already exist and already apply to single images: `image.resize`,
  `image.convert`, `image.compress`.
- Undo/redo history, editor UI state, React components — a later editor-state task doc
  builds on this type; this task doc only defines what a *single* recipe (and a single
  step) is.
- WebGPU/WebGL2 preview rendering — the next task doc, and it will import this schema
  rather than redefine it.
- Wiring recipes into the orchestrator/pipeline engine ("Apply to batch") — Phase 3.

### 1. `apps/web/src/lib/recipe/schema.ts` (new)

Zod (`zod@^4.4`) schema + inferred types, one module:

- `imageProcessorId` — `z.enum(["image.resize", "image.convert", "image.compress"])`.
  Deliberately a subset of the orchestrator's `BUILTIN_PROCESSORS` (video/audio processors
  don't apply to the image editor), and named distinctly so it's obvious this is a
  narrower view, not a competing source of truth for the full processor list.
- Per-processor params schemas, each mirroring its Go doc comment exactly:
  - `resizeParamsSchema`: `width`/`height` — `z.number().int().positive()`; `fit` —
    `z.enum(["inside", "cover"]).default("inside")`.
  - `convertParamsSchema`: `format` — `z.enum(["jpeg", "png", "webp", "avif"])`; `quality`
    — `z.number().int().min(1).max(100).default(85)`.
  - `compressParamsSchema`: `quality` — `z.number().int().min(1).max(100)`.
- `recipeStepSchema` — a **discriminated union** on `processor`, keyed the same way
  `StepDto` shapes a step, so the two stay structurally comparable field-by-field even
  though they're not the same TS type:
  ```ts
  { id: string; processor: "image.resize"; params: ResizeParams }
  | { id: string; processor: "image.convert"; params: ConvertParams }
  | { id: string; processor: "image.compress"; params: CompressParams }
  ```
  `id` is `z.string().min(1)` (matches `StepDto.id`'s `@IsNotEmpty()`). No `dependsOn`
  field: Phase 2 recipes are always a single linear chain expressed by array order, same
  end result as `resolveLinearOrder()` produces for pipelines, just without needing the
  field because a recipe is never branching, not even structurally.
- `recipeSchema` — `z.object({ name: z.string().min(1).optional(), steps:
  z.array(recipeStepSchema) })`. `steps` may be empty (a brand-new, unedited image has a
  recipe with zero steps — original-plus-recipe with an empty recipe is just the
  original).
- Exported inferred types: `RecipeStep`, `Recipe`, plus the per-processor param types
  (`ResizeParams`, `ConvertParams`, `CompressParams`) for the composite-slider work and
  preview renderer to consume later.

### 2. `apps/web/src/lib/recipe/schema.test.ts` (new)

Vitest (`[VERIFY: confirm apps/web's test runner — create-next-app@latest doesn't
scaffold one; check current Next.js docs' own testing recommendation before adding a
dependency, per CLAUDE.md §2.0]`) unit tests, no I/O:

- Valid recipe with all three processor types round-trips through `recipeSchema.parse`.
- Each processor's required-param omission is rejected (`width` missing on resize,
  `format` missing on convert, `quality` missing on compress).
- `fit`/`quality` defaults apply when omitted, matching the Go defaults
  (`vips.InterestingNone`/`defaultQuality` — confirm the literal default value in
  `workers/internal/processors/*.go`'s `defaultQuality` constant matches `85` before
  asserting it in a test, don't assume).
- Out-of-range `quality` (0, 101) rejected on all three processors that take it.
- Unknown `processor` value rejected (discriminated union has no fallback case).
- Empty `steps` array is valid.

### 3. `apps/web/package.json` (edit)

Add `zod` (`^4.4.3` — latest stable per `npm view zod version` on the day this task was
written; re-check per CLAUDE.md §2.0 before installing if this task is picked back up
later) as a dependency, and whatever the chosen test runner is as a devDependency.

### 4. `docs/plexus-media-pipeline-spec.md` (edit)

"Core Concepts" already describes the Edit Recipe informally; add a short cross-reference
to `apps/web/src/lib/recipe/schema.ts` as the concrete type, once it exists, so the spec
doesn't just gesture at the shape in prose.

### 5. `docs/90-deferred-register.md` (edit)

- Update `D-1`: `packages/`'s recipe-schema trigger is **not** firing yet, on purpose —
  record why (see Porquê below) and restate the real trigger as "Phase 3, when
  `apps/orchestrator` needs to read/write recipes for Apply to Batch — at that point
  `RecipeStep`/`Recipe` moves from `apps/web/src/lib/recipe/` into `packages/` and both
  `apps/web` and `apps/orchestrator` import the same definition instead of two
  hand-kept-parallel shapes."
- New `D-xx`: the near-term duplication itself — `RecipeStep`'s processor/param shapes are
  hand-kept parallel to `StepDto`/`PipelineStepDefinition` (Zod vs. class-validator, two
  different files, two different languages of validation-library) rather than sharing a
  definition, same category of debt as `D-8`'s NATS message duplication. Re-evaluation
  trigger: Phase 3 `packages/` move (same trigger as the `D-1` update above), or sooner if
  the shapes actually drift and cause a bug.
- New `V-xx` (or fold into existing `[VERIFY]` process): the test-runner choice for
  `apps/web` is unverified pending checking Next.js's current docs, per item 2 above.

## Porquê

The spec's own reuse proof ("a recipe built by hand on one image successfully runs
unmodified as a batch pipeline across many files") requires the recipe type and the
pipeline type to be structurally identical *by construction*, not by two people
remembering to keep two hand-written shapes in sync. Since Phase 2 has no orchestrator
consumer yet (batch integration is explicitly Phase 3), sharing a literal package today
would mean scaffolding `packages/` for a single consumer — exactly the premature-scaffold
risk `D-1` and CLAUDE.md §2.0 already flagged (framework/tooling drift on an unused
package). Keeping the recipe schema inside `apps/web` for now, deliberately shaped to
mirror `StepDto` field-for-field, gets the same reuse guarantee in practice during Phase 2
without inventing a shared package ahead of its first real second consumer — and gives
Phase 3 a clean, well-scoped move (promote one file to `packages/`, delete the parallel
orchestrator DTO fields it subsumes) instead of a redesign.

Typed-per-processor params (a discriminated union) instead of `Record<string, unknown>`
is a deliberate divergence from `StepDto`'s looser shape: the editor's live preview
(next task doc) needs to map recipe params to shader uniforms, and the composite-slider
work (`D-6`) needs to read/write specific fields by name. A stringly-typed params bag would
just push that type safety into every consumer instead of the schema once. The
orchestrator's own params stay a validated-at-runtime `Record<string, unknown>` for now
because `class-validator`'s `@IsObject()` on `StepDto.params` doesn't discriminate by
`processor` either — that's a Phase 1 simplification of its own, not something this task
changes.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/recipe/schema.ts` | new | `Recipe`/`RecipeStep` Zod schema + inferred types, mirrors `StepDto` field-for-field |
| `apps/web/src/lib/recipe/schema.test.ts` | new | Unit tests: valid round-trip, required-param rejection, defaults, range validation, unknown processor rejection |
| `apps/web/package.json` | edit | Add `zod`; add chosen test runner devDependency |
| `docs/plexus-media-pipeline-spec.md` | edit | Cross-reference concrete recipe type from "Core Concepts" |
| `docs/90-deferred-register.md` | edit | Update `D-1`'s trigger note; add new `D-xx` for the deliberate near-term schema duplication; add `[VERIFY]`/`V-xx` for test-runner choice |
