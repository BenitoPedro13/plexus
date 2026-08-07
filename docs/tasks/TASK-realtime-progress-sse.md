# TASK: Realtime job progress via SSE

## Cenário actual

Job/step status only exists as rows in Postgres, readable exactly one way:
`GET /jobs/:id` (`apps/orchestrator/src/jobs/jobs.controller.ts` →
`JobsService.findOne`), which a client must poll. The actual status transitions already
happen in real time server-side — `apps/orchestrator/src/jobs/job-result-handler.ts`'s
`handleStepResult` (driven by `JobResultConsumerService` consuming
`plexus.jobs.results` off NATS JetStream, `apps/orchestrator/src/nats/nats.service.ts`)
updates `jobSteps`/`jobs` status the moment a worker reports a step result — there's just
no channel forwarding that moment to a browser. The spec's stack table is explicit that
NATS JetStream is "one piece of infra for both job dispatch and the realtime progress
stream" — that second half has never been built.

`apps/web` has no SSE/WebSocket client code anywhere (confirmed — grep turns up nothing),
consistent with there being no server endpoint to connect to yet.

## Mudanças planeadas

- **`apps/orchestrator/src/jobs/job-result-handler.ts`** — `handleStepResult` gains one
  more effect alongside its existing DB writes: publish a small progress-event payload
  (`{ jobId, jobStepId, stepId, status, order, error? }`) to a new NATS subject,
  `plexus.jobs.events` (added to `PLEXUS_JOBS_STREAM`'s existing `plexus.jobs.>` wildcard —
  no stream config change needed, `nats.service.ts`'s `streams.add` already covers it).
  Published **after** the DB transition succeeds, not before, so a crash between the two
  never reports a status the DB doesn't actually have yet. `JobDispatchService`'s own
  QUEUED→RUNNING and →COMPLETE transitions (`ensureRunning`/`settleComplete`) get the same
  treatment, since those are job-level transitions `handleStepResult` doesn't itself cover.
- **Why NATS-mediated, not an in-process EventEmitter:** the orchestrator is meant to run
  as more than one replica eventually (nothing in the spec restricts it to one), and an
  SSE client connected to replica A must still see progress for a job whose result was
  consumed by replica B. Publishing through NATS (which every replica already connects to)
  makes the fan-out correct regardless of which replica processes the underlying
  `plexus.jobs.results` message or which replica the SSE client happens to be connected to
  — an in-process emitter would silently only work in today's single-replica local dev and
  break the moment a second replica existed, exactly the kind of untested-at-scale gap
  CLAUDE.md warns about.
- **`apps/orchestrator/src/jobs/jobs.controller.ts`** — new `GET /jobs/:id/events` (SSE,
  NestJS's `@Sse()` decorator returning an `Observable<MessageEvent>`). Opens an
  **ephemeral** (non-durable, `DeliverPolicy.New` or `.LastPerSubject` — `[VERIFY: which
  JetStream ephemeral-consumer options `@nats-io/jetstream` actually exposes before
  choosing]`) consumer on `plexus.jobs.events` filtered to the requested `jobId`, translates
  each message into an SSE event, and closes the consumer + completes the observable once a
  terminal job status (`COMPLETE`/`FAILED`) is observed or the client disconnects
  (NestJS's own `@Sse()` teardown on request close). Ephemeral, not durable, because SSE
  progress is inherently "catch up from now," not "replay everything since job creation" —
  a client that reconnects mid-job should get a fresh snapshot (see next bullet), not a
  backlog replay.
- **`apps/orchestrator/src/jobs/jobs.service.ts`** — the SSE handler's first emitted event
  is a synthesized snapshot built from the current DB row (`findOne`'s existing query), not
  just "wait for the next NATS message" — otherwise a client connecting to an
  already-halfway-done job sees nothing until the *next* step transitions, which is wrong
  for a page loaded partway through a long job.
- **`apps/web`** — new `apps/web/src/lib/jobs/useJobProgress.ts` (a small hook wrapping the
  browser's native `EventSource`, reconnect-on-drop via `EventSource`'s own automatic
  retry, no library dependency needed for this). Not wired into any specific page in this
  task — `TASK-apply-to-batch.md` is the first real consumer (a batch-progress view), kept
  separate so this task is testable on its own against the existing single-image `POST
  /jobs` path.

## Porquê

This is a standalone P0 spec bullet ("Real-time progress via SSE/WebSocket, driven off the
same event stream used for job dispatch") independent of Apply to Batch — it's useful the
moment a single job exists, and building it now means `TASK-apply-to-batch.md` can consume
a working progress channel instead of building both at once. SSE over WebSocket: progress
events are one-directional (server→client only, no client→server messages needed once a
job is created), and SSE gets automatic reconnection and plain-HTTP infra compatibility
for free — a WebSocket upgrade buys nothing here and costs more (its own reconnect/ping
handling). Routing through NATS rather than an in-process emitter is the one decision in
this task that isn't obvious from the endpoint alone — see the inline note above; getting
it wrong now would mean redoing this task later the first time the orchestrator actually
runs more than one replica.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/src/jobs/job-result-handler.ts` | edit | publish `plexus.jobs.events` after each DB transition |
| `apps/orchestrator/src/jobs/job-dispatch.service.ts` | edit | publish on job-level QUEUED→RUNNING / →COMPLETE |
| `apps/orchestrator/src/jobs/job-progress-event.ts` | new | shared event payload type |
| `apps/orchestrator/src/jobs/jobs.controller.ts` | edit | add `GET /jobs/:id/events` (`@Sse()`) |
| `apps/orchestrator/src/jobs/jobs.service.ts` | edit | snapshot-first SSE stream construction |
| `apps/web/src/lib/jobs/useJobProgress.ts` | new | `EventSource`-based hook, unused until `TASK-apply-to-batch.md` |
| `docs/plexus-media-pipeline-spec.md` | edit | mark realtime-progress P0 bullet's mechanism as implemented |
| `docs/90-deferred-register.md` | edit | log any `[VERIFY]` items opened above (ephemeral consumer deliver-policy choice) |
