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

**Revised from the original plan below** after checking NATS JetStream's own documented
constraints (not assumed) before implementing, per CLAUDE.md §0/§2.0:

1. **WorkQueue-retention streams reject overlapping consumer filter subjects.**
   `PLEXUS_JOBS_STREAM` (`nats.service.ts`) is `RetentionPolicy.Workqueue` — confirmed
   (`nats-io/nats-server` issue #3639 / discussion #3637) that a WorkQueue stream allows
   only *disjoint* filter subjects across its consumers; two ephemeral consumers both
   filtered to the same job's events subject (e.g. two browser tabs open on the same job,
   or a reconnect racing its predecessor's cleanup) would collide. The original plan's
   "publish onto `plexus.jobs.>`, no stream change needed" would have inherited this
   restriction invisibly.
2. **A subject can only belong to one stream.** Even reusing `plexus.jobs.>` for a
   differently-configured *second* stream isn't an option — JetStream rejects a new stream
   whose subjects overlap an existing one's (`JSStreamSubjectOverlapErr`, confirmed via
   nats-server's own issue tracker), so progress events need a subject prefix disjoint from
   `plexus.jobs.>`, not a wildcard already claimed by the dispatch/results stream.

Revised design: a **second stream**, `PLEXUS_JOB_EVENTS` (`RetentionPolicy.Limits`,
`max_age` 10 minutes — a first-pass default, long enough to cover a client reconnecting
shortly after a job settles, short enough not to accumulate stale history indefinitely),
subjects `plexus.events.jobs.>` (disjoint from `plexus.jobs.>`). Each job publishes to its
own subject, `plexus.events.jobs.<jobId>`, so a per-connection **ephemeral** consumer
(`name` set, no `durable_name` — "Set `name` for ephemeral consumers" per
`@nats-io/jetstream`'s own `ConsumerConfig` type) can `filter_subject` to just that job
without the WorkQueue-overlap restriction applying (Limits retention has no such
restriction — confirmed by reading `@nats-io/jetstream`'s own `jsapi_types.d.ts`). Each
consumer also sets `inactive_threshold` (60s) as a server-side safety net in case the
owning SSE connection's own cleanup never runs (e.g. an ungraceful process exit).

- **`apps/orchestrator/src/nats/nats.service.ts`** — `onModuleInit` additionally creates
  `PLEXUS_JOB_EVENTS_STREAM` as described above. New exports: `PLEXUS_JOB_EVENTS_STREAM`,
  `jobEventsSubject(jobId)`. New method `ephemeralJobEventsConsumer(jobId)`: adds a
  `name`-only (ephemeral) pull consumer (`AckPolicy.None` — these are fire-and-forget
  progress notifications, not work to be redelivered; `DeliverPolicy.New` — "catch up from
  now," see below) filtered to `jobEventsSubject(jobId)`, returns the `Consumer` handle.
- **`apps/orchestrator/src/jobs/job-progress-event.ts`** (new) — the `JobProgressEvent`
  union (`scope: 'snapshot' | 'job' | 'step'`) and a `publishJobProgress(natsService,
  event)` helper that publishes to `jobEventsSubject(event.jobId)`.
- **`apps/orchestrator/src/jobs/job-result-handler.ts`** — `handleStepResult` gains a
  `natsService` param and publishes a `scope: 'step'` event after each step
  COMPLETE/FAILED transition actually applies (skipped on the "already applied"
  `IllegalTransitionError` no-op path, so redelivery never double-publishes), and a
  `scope: 'job'` event after the job-level FAILED transition. Published **after** the DB
  transition succeeds, not before, so a crash between the two never reports a status the
  DB doesn't actually have yet.
- **`apps/orchestrator/src/jobs/job-dispatch.service.ts`** — `dispatchNext`'s own
  PENDING→RUNNING step transition (starting the next step) now also publishes a `scope:
  'step'` event — the original plan only covered step *completion*, missing "a step
  started" as a real progress signal a client would want. `ensureRunning`/`settleComplete`
  (job-level QUEUED/PARTIAL→RUNNING, →COMPLETE) publish `scope: 'job'` events, as
  originally planned.
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
  NestJS's `@Sse()` decorator). Confirmed against `@nestjs/common`/`@nestjs/core`'s own
  installed types/source (11.1.28), not assumed: the decorator accepts a method returning
  either `Observable<MessageEvent>` directly or a `Promise` of one; the framework tears
  down the subscription (calls the Observable's own teardown function) on client
  disconnect automatically (`router-response-controller.js`'s `sse()`), so consumer cleanup
  belongs in the Observable's teardown, not a separate lifecycle hook.
- **`apps/orchestrator/src/jobs/jobs.service.ts`** — new `streamEvents(jobId):
  Observable<MessageEvent>`, built with `new Observable(subscriber => {...})`. Order of
  operations chosen deliberately: **create the ephemeral consumer first, fetch the DB
  snapshot second** — the reverse of a naive "snapshot then subscribe" order — so any event
  published in the gap between the two is captured by the consumer and, at worst, is
  re-observed as a harmless duplicate already reflected in the snapshot, rather than
  silently missed (a `DeliverPolicy.New` consumer created *after* the snapshot could miss
  an event published in that same gap, with no later signal that anything was skipped).
  Emits the snapshot as `{ scope: 'snapshot', job }` first; if already terminal
  (COMPLETE/FAILED), completes immediately without touching NATS further. Otherwise
  consumes `plexus.events.jobs.<jobId>` and forwards each message as an SSE `MessageEvent`,
  completing the observable when a terminal `scope: 'job'` event is observed. The
  Observable's teardown function (runs on unsubscribe, error, complete, *and* client
  disconnect per the framework behavior above) stops the consumer's message loop and
  best-effort deletes the ephemeral consumer.
- **`apps/web`** — new `apps/web/src/lib/jobs/useJobProgress.ts` (a small hook wrapping the
  browser's native `EventSource`, reconnect-on-drop via `EventSource`'s own automatic
  retry, no library dependency needed for this) plus a pure, unit-tested
  `applyJobProgressEvent(current, event)` reducer (same extraction precedent as
  `light-blend.ts`/`crop-drag.ts`) that folds each incoming event into the locally-held
  `JobSummary` (mirroring `apps/web/src/lib/editor/batch-progress.ts`'s existing shape).
  The hook closes its own `EventSource` once a terminal status is observed, rather than
  leaving the browser's default auto-reconnect to repeatedly reopen a stream that will
  just immediately re-complete. Not wired into any specific page in this task —
  `TASK-apply-to-batch.md`'s batch view (`apps/web/src/app/batch/[pipelineId]`) still polls
  via `batch-progress.ts`'s `fetchJob`; swapping it to this hook is a follow-up, not part of
  this task's scope.

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
| `apps/orchestrator/src/nats/nats.service.ts` | edit | new `PLEXUS_JOB_EVENTS` stream (Limits retention, disjoint `plexus.events.jobs.>` subject), `jobEventsSubject()`, `ephemeralJobEventsConsumer()` |
| `apps/orchestrator/src/jobs/job-progress-event.ts` | new | `JobProgressEvent` union + `publishJobProgress()` helper |
| `apps/orchestrator/src/jobs/job-result-handler.ts` | edit | takes `natsService`, publishes step COMPLETE/FAILED + job FAILED events |
| `apps/orchestrator/src/jobs/job-dispatch.service.ts` | edit | publish step RUNNING (in `dispatchNext`) and job RUNNING/COMPLETE (`ensureRunning`/`settleComplete`) |
| `apps/orchestrator/src/jobs/job-result-consumer.service.ts` | edit | thread `natsService` through to `handleStepResult` |
| `apps/orchestrator/src/jobs/jobs.controller.ts` | edit | add `GET /jobs/:id/events` (`@Sse()`) |
| `apps/orchestrator/src/jobs/jobs.service.ts` | edit | inject `NatsService`; new `streamEvents()` (consumer-before-snapshot, snapshot-first emission) |
| `apps/orchestrator/src/jobs/job-dispatch.integration-spec.ts` | edit | pass `testBroker.natsService` into `JobsService` |
| `apps/orchestrator/src/jobs/jobs.service.integration-spec.ts` | edit | pass `testBroker.natsService` into `JobsService`; new `streamEvents` cases |
| `apps/orchestrator/src/jobs/job-result-consumer.integration-spec.ts` | edit | pass `testBroker.natsService` into `JobsService`/`handleStepResult` |
| `apps/web/src/lib/jobs/useJobProgress.ts` | new | `EventSource`-based hook + pure `applyJobProgressEvent` reducer |
| `apps/web/src/lib/jobs/useJobProgress.test.ts` | new | reducer unit tests + a fake-`EventSource` hook test |
| `docs/plexus-media-pipeline-spec.md` | edit | mark realtime-progress P0 bullet / Phase 3 phasing note as implemented |
| `docs/90-deferred-register.md` | edit | log the WorkQueue-overlap and stream-subject-overlap findings and the `max_age`/`inactive_threshold` first-pass defaults |
