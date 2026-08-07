# TASK: Branching / parallel DAG pipelines

## Cenário actual

Pipelines are validated and executed as a **single linear chain**, even though the DAG
primitive (`dependsOn: string[]` per step) already exists end-to-end in the schema — it was
deliberately seeded and then thrown away:

- `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts:92-110` — `StepDto` has
  `id`, `processor`, `params`, and optional `dependsOn?: string[]`. Comment: "Phase 1
  pipelines are linear... enforced by `resolveLinearOrder()`."
- `apps/orchestrator/src/pipelines/linear-dag.validator.ts` — `resolveLinearOrder()`
  throws `BRANCHING_NOT_SUPPORTED` the moment any step has more than one dependent
  (fan-out) or more than one dependency (fan-in), and `MULTIPLE_ROOTS` the moment more
  than one step has no `dependsOn` at all. Its own doc comment: "Replaced by real DAG
  resolution in Phase 3."
- `apps/orchestrator/src/pipelines/pipelines.service.ts:12-13` — `resolveLinearOrder()`'s
  result (a flattened array) is what gets persisted; **`dependsOn` itself is discarded**,
  only array order survives into `pipelines.definition`.
- `apps/orchestrator/src/jobs/job-dispatch.service.ts` `dispatchNext()` — picks `steps.find(s
  => s.status === 'PENDING')` (the *first* pending step in array order, never more than
  one), and chains input via `steps.find(s => s.order === next.order - 1)` — literally "my
  input is whatever finished immediately before me in the array." Nothing here understands
  a dependency graph; `order - 1` *is* the dependency resolution.
- `apps/orchestrator/src/db/schema.ts` — `jobStepStatusEnum` already includes `SKIPPED` and
  `jobStatusEnum` already includes `PARTIAL`, both unused today. Their own comments:
  `SKIPPED` "is reserved for Phase 3 branching pipelines" (`job-status.ts:29`); `PARTIAL`
  exists so "a job with more steps left can report partial progress" but nothing ever
  transitions a job to it (confirmed via grep — `PARTIAL` appears only in the enum and in
  `job-dispatch.service.ts`'s `ensureRunning` guard, never as a write target).
- `workers/internal/dispatch/message.go` / `apps/orchestrator/src/jobs/dispatch-message.ts`
  — `StepDispatchMessage`/`StepResultMessage` already correlate by `jobStepId` (a real row
  id), not by `order`, so a result can already be matched to its exact DAG node regardless
  of topology — this part needs no wire-format change.

**A live bug this task also fixes**: `packages/recipe/src/schema.ts`'s `recipeStepSchema`
has **no `dependsOn` field at all** (by design — a recipe is "always a single linear chain
expressed by array order," per its own comment) and `apps/web/src/lib/editor/batch.ts`'s
`createPipelineFromRecipe()` posts `recipe.steps` **unmodified** to `POST /pipelines`
(CLAUDE.md's non-negotiable "no translation step" rule). That means every step in a
real, multi-step editor recipe (e.g. crop → resize → light → color) arrives at the
orchestrator with `dependsOn: undefined` on *all* of them. Under today's
`resolveLinearOrder()`, the second such step throws `MULTIPLE_ROOTS` — confirmed by
`pipelines.service.integration-spec.ts:78-90`, whose own test (2 steps, neither with
`dependsOn`) asserts exactly that rejection. `batch.test.ts`'s recipe fixture only ever
uses a single step, so this never surfaced in a test — but any real "Apply to Batch" click
on a multi-step edit is broken today.

## Mudanças planeadas

**Design decision, made here per CLAUDE.md §1 (recorded before code, not silently
resolved — including one correction found only by running the existing test suite, see
below):** whether a pipeline is in **implicit-chain mode** is a whole-pipeline property,
not a per-step one — true only when *every* step omits `dependsOn` entirely. In that mode,
each step implicitly depends on the immediately preceding array entry (root, if first).
The moment *any* step declares `dependsOn` (including `dependsOn: []`, a genuinely
independent root), the pipeline is in **explicit mode**: every other step's omitted
`dependsOn` means "no dependency" (a root), never implicit chaining. This is what makes a
`dependsOn`-less recipe continue to mean "a strict linear chain" (fixing the bug above,
with zero changes to `packages/recipe` or `batch.ts` — the recipe is still posted
completely unmodified) while letting a hand-authored JSON/YAML pipeline opt into real
branching by writing `dependsOn` explicitly.

The mode has to be whole-pipeline, not per-step ("omitted ⇒ chain to whichever array entry
precedes me"), because a hand-authored pipeline can legally list a step *before* the
(dependsOn-omitting) root it depends on — exactly what
`pipelines.service.integration-spec.ts`'s original "persists a valid linear chain" test
does (`compress`, which explicitly `dependsOn: ['resize']`, is listed *before* `resize`
itself, which has no `dependsOn`). A first implementation pass used the simpler per-step
rule and only caught this by running that pre-existing test: `resize`'s omitted
`dependsOn` was defaulted to `[compress.id]` (its array predecessor) on top of
`compress`'s own explicit `dependsOn: ['resize']`, fabricating a two-node cycle out of a
valid, already-tested DAG. The whole-pipeline flag avoids the ambiguity entirely.

**Fan-in (a step with more than one `dependsOn`) stays unsupported** — no built-in
processor accepts more than one input today (a future `image.watermark`-style compositing
processor would be the first), so building multi-input dispatch now would be speculative;
this becomes a new deferred-register entry, not a silent omission.

1. **`apps/orchestrator/src/pipelines/linear-dag.validator.ts` → renamed
   `dag.validator.ts`** (`git mv`, since the exported names change meaning, not just
   grow): `LinearDagValidationError`/`resolveLinearOrder` → `DagValidationError`/
   `resolveDag`. New reason union: `DUPLICATE_STEP_ID | MISSING_DEPENDENCY |
   FAN_IN_NOT_SUPPORTED | CYCLE_DETECTED` (drops `BRANCHING_NOT_SUPPORTED` and
   `MULTIPLE_ROOTS` — both now legal). Algorithm: apply the implicit-chain default
   described above per step, reject `dependsOn.length > 1` as `FAN_IN_NOT_SUPPORTED`,
   detect cycles via Kahn's algorithm (repeatedly remove zero-indegree nodes; leftover
   nodes ⇒ `CYCLE_DETECTED`) instead of the old single-chain walk, and return steps in
   **topological order** (stable by original array index within a layer) with `dependsOn`
   fully resolved (defaults applied, no longer optional) on every step — downstream
   consumers never need to re-derive the implicit-chain rule.
2. **`apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts`** — update the comment
   on `StepDto.dependsOn` (no longer "at most one dependency... enforced by
   `resolveLinearOrder`"); no field/decorator changes (`dependsOn?: string[]` already
   supports both "absent" and "present-but-empty").
3. **`apps/orchestrator/src/pipelines/pipelines.service.ts`** — call `resolveDag()`
   instead of `resolveLinearOrder()`; persist its output (dependsOn now included) instead
   of discarding it.
4. **`apps/orchestrator/src/db/schema.ts`**:
   - `PipelineStepDefinition.dependsOn` becomes required `string[]` (always resolved by
     `resolveDag()` before storage, never `undefined` past that point).
   - `jobSteps` gets a new `dependsOn: jsonb('depends_on').$type<string[]>().notNull()`
     column, copied from `pipeline.definition` at job-creation time — the same
     already-established pattern `processor`/`params` use (copy into the job snapshot,
     don't join back to `pipelines` on every dispatch). Requires a real migration
     (`pnpm --filter @plexus/orchestrator drizzle-kit generate`, run and committed, not
     hand-written — CLAUDE.md §2).
   - Update the stale "array index is the execution order" comment on `pipelines.definition`.
5. **`apps/orchestrator/src/jobs/jobs.service.ts`** — `create()`/`createBatch()`'s
   `jobSteps` insert gains `dependsOn: step.dependsOn`. `isTerminalJobStatus()` gains
   `'PARTIAL'` alongside `'COMPLETE'`/`'FAILED'` (see #7) so `streamEvents()`'s SSE loop
   closes correctly on a partial-success settlement.
6. **`apps/orchestrator/src/jobs/job-dispatch.service.ts`** — `dispatchNext()` rewritten:
   - Compute the **set** of ready steps: `status === 'PENDING'` AND every id in
     `dependsOn` resolves to a sibling step with `status === 'COMPLETE'` (empty
     `dependsOn` ⇒ ready immediately, input is `job.inputRef`).
   - Dispatch **all** ready steps in the same call (real parallel fan-out), not just one.
     `inputRef` for a step with one dependency is that dependency's `outputRef`
     (`dependsOn.length` is 0 or 1 post-validation — fan-in is rejected upstream, so no
     `inputRefs` map is needed and the NATS message shape is unchanged).
   - The RUNNING transition per ready step becomes a **conditional UPDATE**
     (`WHERE id = $1 AND status = 'PENDING'`, checking the row was actually affected)
     instead of the current SELECT-then-assert pattern. Reasoning: today at most one
     concurrent `dispatchNext()` call could race for a single job (only redelivery could
     trigger a second call); with real parallel branches, sibling branches settling at
     nearly the same instant will routinely trigger concurrent `dispatchNext()` calls for
     the *same* job from different NATS result messages, raising the odds of two calls
     both observing the same step as ready and double-dispatching it. This is a small,
     directly-motivated concurrency fix, not speculative hardening.
   - Settlement, once no step is PENDING-and-ready and none is RUNNING (i.e. every step
     is COMPLETE/FAILED/SKIPPED): all COMPLETE ⇒ job `COMPLETE`; zero COMPLETE (nothing
     ever succeeded) ⇒ job `FAILED` (this is the existing single-chain behavior,
     unchanged — a 1-step pipeline that fails still ends up `FAILED`); a mix of at least
     one COMPLETE and at least one FAILED/SKIPPED ⇒ job `PARTIAL` — the first real use of
     that already-seeded status.
7. **`apps/orchestrator/src/jobs/job-status.ts`**:
   - `JOB_STEP_TRANSITIONS`: add `PENDING: ['RUNNING', 'SKIPPED']` (cascading skip, #8).
   - `JOB_TRANSITIONS`: `PARTIAL` becomes genuinely terminal — `PARTIAL: []` (drop the
     existing `PARTIAL: ['RUNNING']`, which encoded a "paused, resumable" reading of
     `PARTIAL` that this task replaces with "settled with mixed outcome"; nothing in the
     codebase currently depends on resuming from `PARTIAL`, confirmed by grep — no test
     references it at all).
8. **`apps/orchestrator/src/jobs/job-result-handler.ts`** — on a step transitioning to
   `FAILED`, instead of immediately failing the whole job: walk the (fan-in-free, so
   strictly tree-shaped) subtree of steps that transitively depend on the failed step
   and are still `PENDING`, transitioning each to `SKIPPED` (`error` set to reference the
   failed ancestor's `stepId`), publishing a step progress event for each — then call
   `jobDispatchService.dispatchNext()` exactly like the success path, so independent
   sibling branches keep running and `dispatchNext()`'s own settlement logic (#6) decides
   the final job status once everything is terminal. Idempotent the same way the rest of
   this handler already is: an already-`SKIPPED` step throwing `IllegalTransitionError` on
   a redelivered cascade is caught and treated as "already applied," matching the existing
   pattern for redelivered COMPLETE/FAILED transitions.
9. **`apps/orchestrator/src/jobs/job-progress-event.ts`** — `isTerminalJobProgressEvent()`
   gains `'PARTIAL'`.
10. **Tests** (existing suites updated in place, real Postgres/NATS per CLAUDE.md's
    no-mocking rule — no new test infra needed; there was no separate
    `linear-dag.validator.spec.ts` to rename — `resolveLinearOrder` was already only
    exercised end-to-end through `pipelines.service.integration-spec.ts`, so `resolveDag`
    continues to be covered the same way):
    - `pipelines.service.integration-spec.ts`: keep duplicate-id / missing-dependency /
      cycle cases (renamed to the new `DagValidationError` import); replace the "rejects
      branching" and "rejects multiple roots" cases with "resolves a fan-out DAG," "treats
      a fully dependsOn-less definition as an implicit chain" (the bug-fix case, whole-
      pipeline mode — see "Porquê"), and "explicit `dependsOn: []` on two steps yields two
      independent roots"; add a `FAN_IN_NOT_SUPPORTED` case; assert `dependsOn` now
      round-trips through storage.
    - `job-dispatch.integration-spec.ts` / `job-result-consumer.integration-spec.ts`: add
      a real fan-out pipeline (one root, two independent children) exercised against real
      Postgres + NATS — assert both children dispatch in the same `dispatchNext()` call,
      and a failure case asserting the failed branch's descendant is `SKIPPED`, the sibling
      branch still completes, and the job settles `PARTIAL`.
    - `jobs.service.integration-spec.ts` / `job-events.integration-spec.ts`: extend
      `isTerminalJobStatus`/SSE-closes-on-terminal coverage to `PARTIAL`.
    - `job-transitions.integration-spec.ts`: add `dependsOn: []` to the raw `jobSteps`/
      pipeline-definition fixtures (now required columns); split the job-transition test
      so `RUNNING -> PARTIAL` is asserted as terminal (no `-> RUNNING` afterward) rather
      than the old "resume from PARTIAL" path; add `PENDING -> SKIPPED` coverage.
11. **No `apps/web` changes.** `packages/recipe`'s schema, `deriveRecipe()`
    (`apps/web/src/app/editor/page.tsx`), and `batch.ts` are untouched — recipes stay
    implicitly-linear by construction (CLAUDE.md's non-goal: the editor must never expose
    DAG/branching concepts), and the implicit-chain default in `resolveDag()` is exactly
    what keeps `recipe.steps` posted unmodified still working, including fixing the
    multi-step bug, with no translation step introduced anywhere.
12. **Docs** (§3 of CLAUDE.md, same pass): `docs/plexus-media-pipeline-spec.md`'s Phase 3
    phasing note updated from "Still open: branching/parallel DAGs" to resolved, with a
    pointer to this task doc. `docs/90-deferred-register.md` gains a new `D-xx` for
    fan-in-not-yet-supported (trigger: a real multi-input processor, e.g. watermark
    compositing, gets built) and, if the CAS-based dispatch fix in #6 doesn't fully close
    the race for very high branch counts, a note on that too.

## Porquê

This is the last item the spec's own "Suggested Phasing" calls out as still open for
Phase 3 ("Real DAGs + realtime + Apply to Batch... Still open: branching/parallel DAGs
(pipelines remain linear)") — SSE and Apply-to-Batch already landed. It's also not
speculative: the schema (`dependsOn`, `SKIPPED`, `PARTIAL`) was deliberately seeded ahead
of time specifically so this slot-in wouldn't need a migration for those fields — the task
docs for the job state machine and NATS dispatch both say so explicitly ("Phase 3 replaces
it with real DAG resolution... having it isolated means that swap doesn't ripple into the
service"). Doing this now cashes in that seeding rather than letting it bit-rot further.

Separately, and found only by tracing the real code path rather than trusting the existing
passing test suite: today's linear-only validator actively **breaks** the already-shipped
P1 "Apply to Batch" feature for any multi-step edit, because a recipe (by design) never
sets `dependsOn`, and the orchestrator currently demands exactly one `dependsOn`-less step
per pipeline. Fixing this is not a scope-creep add-on to the DAG task — it's the direct
consequence of finishing the DAG resolver properly, since the implicit-chain default this
task needs anyway (recipes must keep working unmodified) is exactly the fix.

Fan-in is deliberately left out even though the schema shape (`dependsOn: string[]`)
already supports the syntax: no built-in processor consumes more than one input today, so
"support it" would mean inventing multi-input dispatch semantics with nothing real to
validate them against — precisely the "code for hypothetical requirements" CLAUDE.md
argues against. Fan-out (fewer moving parts: single input per step, multiple dispatch
targets) has an immediate, concrete use (e.g. one uploaded photo resized for web *and*
thumbnail in parallel from the same source) and is what the concurrency fix in the
dispatch loop is actually being built for.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/src/pipelines/linear-dag.validator.ts` | removal (renamed) | → `dag.validator.ts` |
| `apps/orchestrator/src/pipelines/dag.validator.ts` | new | real DAG resolution: fan-out, multi-root, whole-pipeline implicit-chain mode, fan-in rejected, cycle detection via Kahn's algorithm |
| `apps/orchestrator/src/pipelines/pipelines.controller.ts` | edit | `LinearDagValidationError` → `DagValidationError` |
| `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts` | edit | update `dependsOn` doc comment only |
| `apps/orchestrator/src/pipelines/pipelines.service.ts` | edit | call `resolveDag()`, persist `dependsOn` |
| `apps/orchestrator/src/pipelines/pipelines.service.integration-spec.ts` | edit | branching/multi-root/implicit-chain/fan-in cases (no separate validator spec file existed — this suite already covered `resolveLinearOrder` end-to-end and continues to cover `resolveDag` the same way) |
| `apps/orchestrator/src/db/schema.ts` | edit | `PipelineStepDefinition.dependsOn` required; new `jobSteps.dependsOn` column |
| `apps/orchestrator/drizzle/migrations/*` | new | generated via `drizzle-kit generate`, not hand-written |
| `apps/orchestrator/src/jobs/jobs.service.ts` | edit | copy `dependsOn` into `jobSteps` rows; `isTerminalJobStatus` includes `PARTIAL` |
| `apps/orchestrator/src/jobs/job-dispatch.service.ts` | edit | parallel ready-step dispatch, CAS transition, PARTIAL/FAILED/COMPLETE settlement |
| `apps/orchestrator/src/jobs/job-status.ts` | edit | `PENDING -> SKIPPED` legal; `PARTIAL` terminal |
| `apps/orchestrator/src/jobs/job-transitions.ts` | edit | new `tryStartJobStep()` — atomic conditional UPDATE for the dispatch loop's CAS fix |
| `apps/orchestrator/src/jobs/job-transitions.integration-spec.ts` | edit | `dependsOn: []` on raw fixtures (new required column); split PARTIAL-terminal vs COMPLETE-terminal cases; add `PENDING -> SKIPPED` coverage |
| `apps/orchestrator/src/jobs/job-result-handler.ts` | edit | cascading SKIPPED on failure, always dispatch afterward |
| `apps/orchestrator/src/jobs/job-progress-event.ts` | edit | `isTerminalJobProgressEvent` includes `PARTIAL` |
| `apps/orchestrator/src/jobs/job-dispatch.integration-spec.ts` | edit | add fan-out dispatch case |
| `apps/orchestrator/src/jobs/job-result-consumer.integration-spec.ts` | edit | add cascade-skip / PARTIAL settlement case |
| `apps/orchestrator/src/jobs/job-events.integration-spec.ts` | edit | SSE closes on `PARTIAL` (new fan-out test) |
| `docs/plexus-media-pipeline-spec.md` | edit | Phase 3 phasing note: branching/DAGs resolved |
| `docs/90-deferred-register.md` | edit | new `D-xx`: fan-in still unsupported (no multi-input processor exists) |
