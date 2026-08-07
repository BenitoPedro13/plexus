# TASK: Include outputRef on step-completion SSE events

## Cenário actual

`apps/orchestrator/src/jobs/job-progress-event.ts`'s `JobProgressEvent` union has three
variants: `snapshot` (a full DB row, `Job & { steps: JobStep[] }`, only ever emitted once
per SSE connection as the first event — `jobs.service.ts`'s `streamEvents()`), `job`
(`{ jobId, status }`), and `step` (`{ jobId, jobStepId, stepId, order, status, error? }`).
The `step` variant does not carry `outputRef`.

`job-result-handler.ts`'s `handleStepResult` already has the completed step's `outputRef`
in hand — `transitionJobStepStatus` returns `appliedStep: JobStep`, which includes
`outputRef` (written in the same transition, `{ outputRef: result.outputRef, error:
result.error }`) — but the `publishJobProgress(natsService, { scope: 'step', ... })` call
right after it (`job-result-handler.ts:45-53`) only forwards `jobId`, `jobStepId`, `stepId`,
`order`, `status`, `error`. `outputRef` is dropped on the floor even though it's sitting
right there in `appliedStep.outputRef`.

On the frontend, `apps/web/src/lib/jobs/useJobProgress.ts` mirrors the same event shape
(`JobProgressEvent`'s `step` variant, no `outputRef` field) and its `applyJobProgressEvent`
reducer merges only `status`/`error` into the held step. `apps/web/src/lib/editor/batch-
progress.ts`'s `jobOutputRef(job)` reads `job.steps.at(-1)?.outputRef` — which is only ever
populated by the connection's initial `snapshot` event (a DB read taken at connect time,
before the step has necessarily completed). `useJobProgress.ts:112-114` closes the
`EventSource` the instant a terminal `job`-scope status is observed, so no later event can
ever refresh it either.

**Net effect, confirmed by reading the code path end to end**: connect while a job is
`RUNNING` (the normal case — a user watches their own job run) → snapshot's `outputRef` is
`null` → step completes, a `step` event flips its `status` to `COMPLETE` but `outputRef`
stays `null` in local state (never sent) → job completes, a `job` event flips overall status
to `COMPLETE` → the `EventSource` closes itself immediately → `jobOutputRef(job)` now and
forever evaluates to `undefined` → the Download button (`apps/web/src/app/quick-
actions/[jobId]/page.tsx:96-108`, gated on `downloadUrl`, itself gated on `jobOutputRef`
returning something) never renders. Only a manual page reload (which re-fetches a fresh,
now-complete `snapshot`) recovers it. This matches the reported bug exactly: "after i
received complete on the stream it didnt update the ui so i could download."

## Mudanças planeadas

1. **`apps/orchestrator/src/jobs/job-progress-event.ts`** — add `outputRef?: string` to the
   `step`-scope variant of `JobProgressEvent`.
2. **`apps/orchestrator/src/jobs/job-result-handler.ts`** — the `publishJobProgress` call in
   `handleStepResult` includes `outputRef: appliedStep.outputRef ?? undefined`.
3. **`apps/web/src/lib/jobs/useJobProgress.ts`** — mirror the same `outputRef?: string`
   field on the frontend's `JobProgressEvent` `step` variant; `applyJobProgressEvent`'s
   `step` branch merges `outputRef: event.outputRef ?? step.outputRef` (falls back to
   whatever was already known rather than clobbering it, though in practice `outputRef` and
   `status: 'COMPLETE'` are always published together).
4. **`apps/web/src/lib/jobs/useJobProgress.test.ts`** — new reducer case: a `step` event
   with `status: 'COMPLETE'` and `outputRef` set updates the held step's `outputRef`, and
   `jobOutputRef()` on the resulting `JobSummary` returns it — i.e. the Download link becomes
   available without any snapshot refetch.
5. No change needed to `apps/web/src/lib/editor/batch-progress.ts` — `JobStepSummary` and
   `jobOutputRef()` are already correct; they were just never being fed the value.

## Porquê

The backend already computes and stores `outputRef` at the exact moment it publishes the
completion event — this is a one-field oversight in `TASK-realtime-progress-sse.md`'s
original event shape, not a design tradeoff to preserve. Fixing it closes the gap between
"the stream says complete" and "the user can actually get their file" reported directly by
the user, and removes the current silent dependency on a page reload that nothing in the UI
tells the user they need to do.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/src/jobs/job-progress-event.ts` | edit | add `outputRef?: string` to the `step` variant |
| `apps/orchestrator/src/jobs/job-result-handler.ts` | edit | publish `appliedStep.outputRef` on the step event |
| `apps/web/src/lib/jobs/useJobProgress.ts` | edit | mirror `outputRef` field; reducer merges it into the held step |
| `apps/web/src/lib/jobs/useJobProgress.test.ts` | edit | new case: step-complete event with `outputRef` makes `jobOutputRef()` resolve without a snapshot refetch |
