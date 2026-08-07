# TASK: Apply to Batch — wire the editor recipe into the pipeline engine

## Cenário actual

The editor (`apps/web/src/app/editor/page.tsx`) and the pipeline engine
(`apps/orchestrator` + `workers/`) are two fully separate, working systems that have never
been connected:

- The editor builds a `Recipe` (`@plexus/recipe` after `TASK-recipe-packages-extraction.md`,
  or `apps/web/src/lib/recipe/schema.ts` before it) and can only do one thing with it:
  `apps/web/src/lib/editor/export.ts`'s `exportRecipe` — a synchronous, single-image
  `POST /export` → `workers/cmd/renderserver`'s `POST /render` round trip
  (`TASK-editor-export.md`, resolved `D-37`). That path is explicitly outside the async
  job/pipeline machinery by design (`D-37`'s own note: "reserved for Phase 3's Apply to
  Batch").
- `apps/orchestrator`'s `POST /pipelines` + `POST /jobs` async path exists and is fully
  tested (`TASK-nats-job-dispatch.md`, `TASK-job-state-machine.md`) but has never been
  driven by anything other than hand-constructed test payloads — nothing in `apps/web`
  calls it.
- There is no UI anywhere for "pick more than one file" — the editor's `loadFile()`
  (`apps/web/src/app/editor/page.tsx`) takes exactly one `File`, and nothing downstream of
  it expects more.
- This is the concrete, un-shipped proof of the spec's central thesis: "a recipe built by
  hand on one image runs *unmodified* as a batch pipeline across many files. No 'convert my
  edit into a pipeline' translation step may ever appear" (CLAUDE.md, "Things that must not
  break"). Today, nothing tests or even exercises that claim — it is architecturally true
  (both systems consume `Recipe`/`PipelineStepDefinition` today, and after `TASK-recipe-
  packages-extraction.md`, the literal same schema) but has zero code path proving it.

**Depends on** `TASK-presigned-upload.md` (many files need to actually reach
worker replicas) and `TASK-recipe-packages-extraction.md` (the orchestrator must accept
every processor id the editor can produce, not just Phase 1's original seven). Benefits
from, but doesn't strictly require, `TASK-realtime-progress-sse.md` (batch progress is far
more useful with live per-file status than a polling loop over N job ids).

## Mudanças planeadas

- **`apps/orchestrator/src/pipelines/`** — `POST /pipelines` already accepts a
  `PipelineStepDefinition[]`; after `TASK-recipe-packages-extraction.md` this *is* a
  `Recipe`'s `steps`, unmodified. No new endpoint needed here — the existing one becomes
  the batch-pipeline-creation call, used exactly as-is. This is the concrete "no
  translation step" proof: `apps/web`'s Apply-to-Batch flow calls `POST /pipelines` with
  the editor's own `recipe.steps` value, not a reshaped copy.
- **`apps/orchestrator/src/jobs/`** — new `POST /jobs/batch` accepting `{ pipelineId,
  inputRefs: string[] }` (each an object-storage key from `TASK-presigned-upload.md`'s
  `POST /uploads/presign` flow) — creates N `jobs` rows (one per `inputRef`) against the same
  `pipelineId`, dispatches each via the existing `JobDispatchService.dispatchNext`
  unmodified (it already operates per-job; batching is "call it N times," not new dispatch
  logic). Returns the N created job ids. `[VERIFY: whether NestJS + Drizzle's transaction
  API can wrap the N inserts atomically so a partial-batch DB failure doesn't leave orphan
  jobs — check drizzle-orm's node-postgres transaction docs before assuming `db.transaction`
  behaves like a single top-level connection here.]`
- **`apps/web/src/app/editor/page.tsx`** — new "Apply to Batch" entry point (behind the
  existing Export button, or a new button beside it — a UI-only decision, not a data-model
  one). Opens a multi-file picker (reusing the existing dropzone's drag-and-drop
  affordance, extended to accept multiple files rather than the current single-`File`
  path), uploads each file via `TASK-presigned-upload.md`'s `POST /uploads/presign`
  endpoint, `POST /pipelines` once with the current `deriveRecipe()` output, then `POST
  /jobs/batch` with the resulting `pipelineId` and every uploaded key.
- **`apps/web/src/app/batch/[pipelineId]/page.tsx` (new)** — a batch-progress view: one
  row per job, each subscribed via `useJobProgress` (`TASK-realtime-progress-sse.md`) if
  that task has landed, otherwise a polling fallback against `GET /jobs/:id` — written so
  the SSE hook is a drop-in upgrade, not a rewrite, regardless of task order. Each completed
  job's row gets a download link (`GET` against the object-storage key returned by its
  final step, presigned for download).
- **`apps/orchestrator/src/jobs/dto/` / job creation** — batch job rows need their final
  `outputRef` surfaced somewhere the batch view can read without walking every `jobSteps`
  row itself; `JobsService.findOne`'s existing response shape may already cover this via
  its last step's `outputRef` — audit before adding a new column or endpoint.
- **Recipe-fidelity regression check**: this is the first time a `Recipe`'s composite
  processor ids (`image.adjustLight` etc.) run through the *async* Go path
  (`workers/internal/dispatch/handler.go` → `processors.Lookup`) at all — they were
  previously only exercised via `workers/internal/render.RunRecipe`'s synchronous chaining
  (`TASK-editor-export.md`). Both call the same `processors.Lookup` registry, so this should
  be a non-event, but it's the kind of "worked in one path, never verified in the other"
  gap `D-34` already found once (the WGSL reserved-word regression) — add a small
  integration test in `workers/internal/dispatch/handler_test.go` (or wherever the
  existing dispatch tests live) exercising at least one composite processor through the
  actual async dispatch path, not just the render-server path, before calling this task
  done.

## Porquê

This is the fusion point the spec's whole architecture is designed around — CLAUDE.md
calls "recipe/pipeline unification" one of three things that must never break, and today
it's an unproven claim, not a tested one. Reusing `POST /pipelines` unmodified (rather than
building a parallel "batch pipeline" concept) is the actual test of that claim: if the
existing pipeline-creation endpoint needs *any* special-casing to accept an editor recipe,
that's a sign the two shapes aren't really unified yet, and this task is where that would
surface. Splitting job-batch-creation into its own `POST /jobs/batch` (rather than looping
`POST /jobs` N times client-side) keeps the "one pipeline, N inputs" relationship a single
atomic-ish server operation instead of N independent client requests that could partially
fail with no clear recovery story — closer to what a real "apply to 500 files" feature
needs than a client-side loop would be.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/src/jobs/jobs.controller.ts` | edit | add `POST /jobs/batch` |
| `apps/orchestrator/src/jobs/jobs.service.ts` | edit | batch job-row creation, N× `dispatchNext` |
| `apps/orchestrator/src/jobs/dto/create-batch-job.dto.ts` | new | `{ pipelineId, inputRefs: string[] }` |
| `apps/web/src/app/editor/page.tsx` | edit | Apply-to-Batch entry point, multi-file upload |
| `apps/web/src/app/batch/[pipelineId]/page.tsx` | new | per-job progress view + download links |
| `apps/web/src/lib/editor/batch.ts` | new | pure helpers: build `POST /pipelines` + `POST /jobs/batch` payloads from `Recipe` + uploaded keys |
| `workers/internal/dispatch/dispatch_test.go` | edit | integration test: composite processor through async dispatch path |
| `docs/plexus-media-pipeline-spec.md` | edit | mark "Apply to Batch" P1 bullet + recipe/pipeline-unification claim as implemented and tested |
| `docs/90-deferred-register.md` | edit | log the Drizzle-transaction `[VERIFY]` if unresolved by implementation time; add `D-40` (permissive CORS) |
| `apps/orchestrator/src/cors.ts` | new | `corsOptions()` — not in the original plan, see Implementação |
| `apps/orchestrator/src/cors.spec.ts` | new | unit test for `corsOptions()` |
| `apps/orchestrator/src/main.ts` | edit | `app.enableCors(corsOptions())` |
| `apps/orchestrator/test/app.e2e-spec.ts` | edit | e2e proof of a reflected `Access-Control-Allow-Origin` header |
| `apps/web/src/lib/editor/batch-progress.ts` | new | polling/download helpers for the batch progress page (not itemized as its own file above; folded into the `apps/web/src/app/batch/[pipelineId]/page.tsx` row originally) |
| `apps/orchestrator/README.md` | edit | add `POST /jobs/batch` to the endpoints table, note `CORS_ORIGIN` |

## Implementação — decisions made that weren't fully pinned above

- **Drizzle transaction `[VERIFY]` resolved: no new API needed.** `create()`'s existing
  single-job transaction already proved a `db.transaction(async (tx) => ...)` callback
  runs every query inside it on one held connection — `createBatch()` just loops over
  `dto.inputRefs` *inside that same callback* rather than opening N transactions. No
  drizzle-orm/node-postgres API beyond what `create()` already used.
- **`POST /jobs/batch` dispatches per-job, after the transaction commits, same as
  `create()`** — one `dispatchNext(job.id)` call per created job, sequentially, for the
  same reason `create()` defers dispatch: a NATS publish can't be rolled back if dispatch
  happened inside the (still-open) transaction and something later failed.
- **`GET /jobs/:id`'s existing response shape needed no changes** — confirmed by direct
  inspection (`JobsService.findOne`, `apps/orchestrator/src/jobs/jobs.service.ts`): steps
  are already order-sorted and each carries `outputRef`, so the batch progress page reads
  `steps.at(-1).outputRef` once that step is `COMPLETE`. No new column, no new endpoint.
- **Job ids travel in the batch page's URL query string (`/batch/[pipelineId]?jobs=id1,id2,…`),
  not a new "list jobs by pipeline" endpoint.** `TASK-realtime-progress-sse.md` hadn't
  landed at implementation time (confirmed by direct inspection: no `useJobProgress`, no
  `@Sse()` route anywhere), so the page uses a 2s `setTimeout` polling loop per job row
  (`apps/web/src/app/batch/[pipelineId]/page.tsx`'s `JobRow`) against `GET /jobs/:id`, per
  the task's own hedge. Swapping in SSE later only touches `JobRow`.
- **Discovered mid-task, fixed in the same pass, not deferred: the orchestrator had no
  CORS configuration at all.** Nothing before this task ever called the orchestrator
  cross-origin from an actual browser (`/export`'s own task never verified it that way
  either) — the first real browser test of Apply-to-Batch failed every request with a
  CORS preflight error. Added `apps/orchestrator/src/cors.ts` (`corsOptions()`, reflecting
  the request `Origin` by default, or a `CORS_ORIGIN` comma-list env var when set) wired
  into `main.ts` via `app.enableCors(corsOptions())`, plus a unit test and an e2e test
  (`app.e2e-spec.ts`) proving `Access-Control-Allow-Origin` actually comes back — the
  e2e suite runs the app the same way `main.ts` does, so it's the one place a missing
  `enableCors()` call would actually get caught. Origin-reflection without credentials is
  safe today only because there's no auth yet (spec Open Question) — logged as `D-40` in
  the deferred register to tighten once auth lands.
- **Also discovered mid-task: neither the orchestrator nor the Go worker ever load `.env`
  into their process environment** — `main.ts` has no `dotenv`/`@nestjs/config` import,
  and the Go worker has no `.env` loader at all. Every prior dev/test run must have relied
  on ambient shell exports or testcontainers setting vars directly. Left this one
  **unfixed here** (out of scope for Apply-to-Batch specifically) — tracked as its own
  task, see `docs/tasks/TASK-dev-run-script.md`.
- **shadcn additions**: `pnpm dlx shadcn@latest add progress badge card` pulled in
  `Progress`/`Badge`/`Card`, per CLAUDE.md §2.0's "use the CLI, not a hand-written file"
  rule (now also explicit about `frontend-design` + shadcn for all `apps/web` UI, added to
  CLAUDE.md in this same pass). `Card` was pulled but not used in the end — the batch
  page's rows match the editor's existing flat/hairline-divider visual language instead of
  `Card`'s rounded/ringed shadcn default, to stay consistent with
  `docs/tasks/TASK-editor-visual-design.md`'s established direction rather than introduce
  a second visual idiom.
- **Not verified in a live browser by the agent** — the user ran the full local stack
  (`docker compose up`, Go worker, orchestrator, web) and drove the Apply-to-Batch flow
  themselves; the agent's own verification was build/lint/`*.integration-spec.ts` (real
  Postgres/NATS/MinIO via testcontainers) + Go `go test` (real NATS/MinIO via
  testcontainers) across all three stacks, per CLAUDE.md's no-mocking rule, plus the CORS
  e2e test above once the browser run surfaced the gap.
