# TASK: Shared recipe/pipeline package (resolves D-1's `packages/`, D-17)

## Cenário actual

The Edit Recipe and the orchestrator's pipeline definition are two independently
hand-maintained shapes, in two languages, that are supposed to be the *same* data structure
per the spec's own core thesis ("Edit one image" and "define a pipeline" are the same
underlying structure viewed through two UIs):

- `apps/web/src/lib/recipe/schema.ts` — Zod, discriminated union per processor id
  (`imageProcessorId`: `image.resize`/`convert`/`compress`/`crop`/`adjustLight`/
  `adjustColor`/`blackAndWhite`/`sharpen`), each with its own typed params schema.
- `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts` — `class-validator`,
  `StepDto.params` is an untyped `Record<string, unknown>`, and its
  `BUILTIN_PROCESSORS` list is **stale**: it only has the original Phase 1 processors
  (`image.resize`/`convert`/`compress`, `video.transcode`/`compress`, `audio.extract`/
  `convert`) — it is missing `image.crop`, `image.adjustLight`, `image.adjustColor`,
  `image.blackAndWhite`, and `image.sharpen` entirely. **Concretely: today, submitting any
  recipe built in `/editor` to `POST /pipelines` would be rejected by `@IsIn(BUILTIN_
  PROCESSORS)` the moment it hit a crop or a composite-slider step** — this is a real,
  confirmed correctness gap, not a hypothetical one, and it's the literal blocker for
  "Apply to Batch."
- No `packages/` directory exists yet (`D-1`) — both `pnpm-workspace.yaml` and each app's
  `package.json` would need updating to add one.
- `packages/` and `proto/` were deliberately left unscaffolded per CLAUDE.md §4 until a
  real consumer exists; `D-1`'s own re-evaluation trigger is exactly "Phase 3, when
  `apps/orchestrator` needs to read/write recipes for Apply to Batch" — that's now.

## Mudanças planeadas

- **`pnpm-workspace.yaml`** — add `packages/*` to the workspace globs (verify current
  pattern against the existing entries rather than assuming).
- **`packages/recipe/`** (new workspace package, name `@plexus/recipe`) — `pnpm create`'s
  own minimal package scaffold (not hand-written `package.json` boilerplate, per CLAUDE.md
  §2), `tsup` or the repo's existing build convention for `apps/web` `[VERIFY: check
  apps/web's own tsconfig/build setup before choosing, don't assume a bundler]`. Contents:
  `apps/web/src/lib/recipe/schema.ts` moves here near-verbatim (it's already the more
  complete, typed-per-processor shape — the orchestrator's `StepDto` is what conforms to
  it, not the other way around). Exports the Zod schemas, the inferred TS types, and a
  `recipeStepToPipelineStep`/`pipelineStepToRecipeStep` pair only if the two shapes still
  need any translation after this task (see next bullet — the goal is *zero* translation).
- **`apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts`** — `BUILTIN_PROCESSORS`
  is replaced by importing `imageProcessorId`'s literal values from `@plexus/recipe`
  (single source of truth, closing the stale-list gap above). `StepDto.params` moves from
  `@IsObject()` (accept-anything) to validating against the matching per-processor Zod
  schema from `@plexus/recipe` — NestJS's `class-validator` and Zod don't compose for free,
  so this likely means a custom `@Validate()` decorator or a `zodToClass` bridge; if neither
  is clean, the fallback is validating the whole `steps` array with the `@plexus/recipe`
  Zod schema directly in `PipelinesService.create()` before the existing `class-validator`
  pass, not silently keeping two divergent validators. Whichever approach is used, record
  it as a decision here, not invented ad hoc mid-implementation.
- **`apps/web/src/lib/recipe/schema.ts`** — becomes a thin re-export of `@plexus/recipe`
  (kept so existing `apps/web` imports don't need a repo-wide rename), or is deleted in
  favor of updating every importer — whichever leaves fewer stale references; decide by
  grepping actual import count before choosing.
- **`apps/web/package.json`** / **`apps/orchestrator/package.json`** — add
  `"@plexus/recipe": "workspace:*"` per CLAUDE.md §4's "workspace deps for shared code,
  never relative cross-app imports."
- **`docs/plexus-media-pipeline-spec.md`** — Core Concepts' "Edit Recipe" paragraph already
  points at `apps/web/src/lib/recipe/schema.ts`; update it to `packages/recipe/` and note
  the orchestrator now imports it too — this is the concrete moment the "same data
  structure, two UIs" claim becomes literally true in code, not just structurally similar.
- **`CLAUDE.md` §4** — flip `packages/` from "proposed but deliberately not yet created"
  to "scaffolded," matching `apps/web`/`apps/orchestrator`/`workers/`'s existing status
  line.

## Porquê

This is the one prerequisite every other Phase 3 piece needs. `TASK-apply-to-batch.md`
literally cannot accept an editor-built recipe as a batch pipeline while the orchestrator's
own DTO would reject half its processor ids — that's not a future risk, it's confirmed by
reading `create-pipeline.dto.ts` directly (see Cenário actual). Doing this as its own task,
ahead of Apply to Batch, keeps the "one recipe/pipeline schema, two consumers" change
isolated and testable on its own (does `POST /pipelines` still validate correctly? do
existing `apps/web` imports still resolve?) before batch-dispatch logic is layered on top
of it.

`D-1`/`D-17`'s original reasoning for deferring this ("only one real consumer today") is no
longer true the moment `apps/orchestrator` needs to read editor recipes — that's this
task's own trigger firing, not a new decision. Keeping `params` as `Record<string,
unknown>` on the orchestrator side, as it is today, means a malformed batch request
(wrong param shape for a given processor) fails at the Go worker, mid-dispatch, instead of
at the API boundary — exactly the class of bug CLAUDE.md's "no silently lost work" framing
warns about, so tightening `StepDto.params`'s validation is in scope here, not a nice-to-
have bolted on later.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `pnpm-workspace.yaml` | edit | add `packages/*` |
| `packages/recipe/package.json` | new | via `pnpm init` / workspace convention, not hand-written |
| `packages/recipe/src/schema.ts` | new | moved from `apps/web/src/lib/recipe/schema.ts` |
| `apps/web/src/lib/recipe/schema.ts` | edit or removal | re-export shim, or deleted with importers updated — decide by import-count |
| `apps/web/package.json` | edit | add `@plexus/recipe` workspace dep |
| `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts` | edit | `BUILTIN_PROCESSORS` sourced from `@plexus/recipe`; `params` validated per-processor |
| `apps/orchestrator/package.json` | edit | add `@plexus/recipe` workspace dep |
| `docs/plexus-media-pipeline-spec.md` | edit | Core Concepts' Edit Recipe paragraph, path update |
| `CLAUDE.md` | edit | `packages/` status: proposed → scaffolded |
| `docs/90-deferred-register.md` | edit | resolve `D-1`'s `packages/` portion and `D-17` |
