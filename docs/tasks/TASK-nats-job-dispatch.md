# TASK — NATS Job Dispatch (Phase 1, slice 2)

## Cenário actual

`TASK-job-state-machine.md` (slice 1, merged in `0852cbc`) gave the orchestrator a
persistence layer and a job state machine, but explicitly stopped short of any transport:
`JobsService.create()` persists a `QUEUED` job plus its `PENDING` `jobSteps` rows inside a
Drizzle transaction and returns — nothing publishes anywhere, nothing consumes anything, and
a job can never leave `QUEUED` because only `transitionJob`/`transitionStep` can move it and
nothing calls them after creation. `workers/cmd/worker/main.go` is still the bare
`nest`-adjacent stub from the original scaffold (`TASK-scaffold-monorepo.md`): it doesn't
import `github.com/nats-io/nats.go` yet, even though that dependency (`v1.52.0`, `jetstream`
subpackage) was already identified and pinned at scaffold time. Postgres and NATS
(`nats:2.14.4-alpine`, JetStream enabled via `-js`) are both running and healthy in
`infra/docker-compose.yml`, and `.env.example` already declares `NATS_URL`, but nothing in
either the orchestrator or the worker connects to NATS today. No JetStream stream, subject,
or message schema exists anywhere in the repo.

This is **slice 2 of Phase 1**: wire the dispatch loop end-to-end over real NATS JetStream —
orchestrator publishes a step, a worker consumes and acks it, the worker publishes a result,
the orchestrator consumes that and drives the state machine forward — without yet doing any
real media processing. Per slice 1's own "Explicitly out of scope" section, this is the task
it named as next.

## Mudanças planeadas

### 0. Schema addition — per-step output ref (small, needed for correct chaining)

`jobSteps` currently has no column to record where a step's output landed. Without one,
"advance to the next step" has no defined input for that next step beyond always reusing the
job's original `inputRef` — which would be silently wrong the moment a real processor (next
task) actually transforms bytes, and would force a migration onto that task instead. Adding
it now, even though this task's worker is a stub:

- **`apps/orchestrator/src/db/schema.ts`** (edit) — add `outputRef: text('output_ref')`
  (nullable) to `jobSteps`.
- Migration generated via `drizzle-kit generate`, per CLAUDE.md §2 (never hand-written).
- `JobDispatchService.dispatchNext()` computes the next step's `inputRef` as: the job's
  `inputRef` for `order === 0`, otherwise the previous step's persisted `outputRef`. The
  result consumer persists `outputRef` on the `jobSteps` row when transitioning a step to
  `COMPLETE`.

### 1. Stream and subject layout — decided here, owned by orchestrator

Per CLAUDE.md §4 ("NATS subjects... owned by exactly one side — decide ownership in the
scaffold task doc"), that decision was deferred to whichever task first needs it. This is
that task:

- One JetStream stream, `PLEXUS_JOBS`, subjects `plexus.jobs.>`, `WorkQueuePolicy` retention
  (each message is processed by exactly one logical consumer and removed on ack — this is a
  true work queue on both subjects below, not a fan-out log, so `WorkQueuePolicy` is correct
  for the whole stream rather than `LimitsPolicy`).
  - `plexus.jobs.dispatch` — orchestrator publishes, Go worker pool consumes (durable pull
    consumer; N worker replicas competing for pulls gives the horizontal-scaling behaviour
    for free, no queue-group config needed beyond a shared durable name).
  - `plexus.jobs.results` — Go worker publishes, orchestrator consumes (durable pull
    consumer, single logical consumer since only the orchestrator drives state).
  - **Not** split per-processor (e.g. `plexus.jobs.dispatch.image.resize`) even though the
    spec's Core Concepts allows arbitrary processor ids: Phase 1 is explicitly "single Go
    worker type" (spec "Suggested Phasing"), so one worker pool consumes everything on one
    subject. Per-processor subject fan-out only matters once external plugins (Phase 4)
    register different processor types to different consumers — new deferred-register entry
    for that, not built speculatively now.
- Stream creation is idempotent and done by the orchestrator at boot (`NatsService`
  below): `jetstreamManager().streams.add(cfg)` — confirmed against the installed
  `@nats-io/jetstream@3.4.0` source that a repeat `STREAM.CREATE` for a config matching the
  existing stream doesn't error (same semantics `nats.go`'s own README documents for Go's
  `CreateStream`). Consumer creation is **not** symmetrically idempotent on the JS client:
  `consumers.add()`'s default action is `"create"`, which errors on an existing durable
  name. `NatsService.durableConsumer()` therefore checks `consumers.info()` first and only
  calls `consumers.add()` on a `ConsumerNotFound` (`JetStreamApiCodes.ConsumerNotFound`,
  code `10014`) error. On the Go side, `jetstream.CreateOrUpdateConsumer` *is* natively
  idempotent, so the worker's self-registered consumer (§4) uses that directly with no
  equivalent check needed.

### 2. Message schema — hand-duplicated JSON across the language boundary (flagged as debt)

No `proto/` or `packages/` exists yet (D-1, still not due until Phase 3/4), so these are
plain JSON payloads with an explicit shape defined independently on each side rather than a
shared generated contract:

- `StepDispatchMessage`: `{ jobId, jobStepId, stepId, processor, params, inputRef, order }`
  — `jobStepId` (the `jobSteps` row's uuid) and `stepId` (the pipeline-definition step id,
  e.g. `"resize"`) are both carried: transitions need the former, logging/debugging wants
  the latter.
- `StepResultMessage`: `{ jobId, jobStepId, status: "complete" | "failed", outputRef?,
  error? }`.

This is CLAUDE.md §4's "no JSON shapes duplicated by hand across the language boundary" rule
being knowingly broken for one task — recorded as a new `D-xx` (see Ficheiros afectados),
not silently accepted.

### 3. Orchestrator — NATS module, dispatch, result consumer

- **`apps/orchestrator/src/nats/nats.module.ts`** (new) — `@Global()`, mirrors
  `DbModule`'s shape.
- **`apps/orchestrator/src/nats/nats.service.ts`** (new) — Nest injectable: `connect()`
  against `NATS_URL` (optional `NATS_USER`/`NATS_PASS`, unused against the unauthenticated
  local compose broker — see below), `onModuleInit` ensures the `PLEXUS_JOBS` stream exists,
  exposes `publish(subject, payload)` (JSON-encodes, `jetstream()` publish) and
  `durableConsumer(subject, durableName, opts?)` (idempotent create-if-missing per the §1
  note, returns a bound `Consumer` for `consume()`/`next()`/`fetch()`). `onModuleDestroy`
  drains the connection.
- **`apps/orchestrator/src/jobs/job-transitions.ts`** (new, not in the original plan) —
  `transitionJobStatus(db, id, to)` / `transitionJobStepStatus(db, id, to, opts?)`: the
  actual DB-aware transition primitives, taking a Drizzle `db` handle directly rather than
  going through `JobsService`. **Why this exists**: `JobsService.create()` needs to trigger
  `JobDispatchService.dispatchNext()` after commit, and `JobDispatchService`/
  `JobResultConsumerService` both need to apply transitions. Routing the latter through
  `JobsService.transitionJob`/`transitionStep` would make `JobsService` and
  `JobDispatchService` depend on each other — a circular Nest provider dependency. Extracting
  the transition logic into plain functions breaks the cycle: `JobsService.transitionJob`/
  `transitionStep` become one-line wrappers around these same functions, so the public API
  and slice 1's tests that called them are unaffected.
- **`apps/orchestrator/src/jobs/job-dispatch.service.ts`** (new) — `dispatchNext(jobId)`:
  loads the job's `jobSteps` ordered by `order`, finds the first `PENDING` step. If none
  remain and every step is `COMPLETE` (or the pipeline has zero steps), settles the job as
  `COMPLETE`. Otherwise: ensures the job is `RUNNING` (`QUEUED`/`PARTIAL` → `RUNNING`),
  transitions the next step `PENDING → RUNNING`, and publishes a `StepDispatchMessage` built
  from that `jobSteps` row — `inputRef` chained from the previous step's persisted
  `outputRef`, or the job's own `inputRef` for the first step (see §0). DB transitions
  commit before the NATS publish (can't roll back a publish if a transaction aborts).
  **Idempotent by construction**, not just by intent: every transition it applies is wrapped
  to swallow `IllegalTransitionError` as "already applied by an earlier call" — this is what
  makes it safe for `JobResultConsumerService` to call again on a redelivered result (see
  below) without double-dispatching a step or double-completing a job.
- **`apps/orchestrator/src/jobs/job-result-handler.ts`** (new, not in the original plan) —
  `handleStepResult(dbService, jobDispatchService, message)`: the actual per-message logic,
  factored out of the consumer service so it's callable directly against a single pulled
  `JsMsg` in tests (see §5) without racing the service's own background loop. Parses
  `StepResultMessage`, calls `transitionJobStepStatus(..., "COMPLETE" | "FAILED", {
  outputRef, error })`, catching `IllegalTransitionError` as "already applied". On
  `"complete"`, calls `jobDispatchService.dispatchNext(jobId)` (which itself is idempotent —
  see above) rather than only doing this on the *first* successful application; on
  `"failed"`, transitions the job to `FAILED` (also `IllegalTransitionError`-tolerant).
  **`message.ack()` only after all of that succeeds** — an uncaught error anywhere above
  leaves the message unacked, so JetStream redelivers it, and because every step here is
  idempotent, redelivery is always safe to just replay from scratch. This is the actual "no
  lost jobs" mechanism (the redelivery test in §5 proves it end-to-end).
- **`apps/orchestrator/src/jobs/job-result-consumer.service.ts`** (new) —
  `OnModuleInit`/`OnModuleDestroy`, binds one durable pull consumer (`"jobs-results"`) to
  `plexus.jobs.results` and runs a `consume()` loop for the module's lifetime, calling
  `handleStepResult()` per message and logging (not throwing) on failure so one bad message
  doesn't kill the loop.
- **`apps/orchestrator/src/jobs/dispatch-message.ts`** (new) — the `StepDispatchMessage`/
  `StepResultMessage` TS interfaces from §2.
- **`apps/orchestrator/src/jobs/jobs.service.ts`** (edit) — `create()` calls
  `jobDispatchService.dispatchNext(job.id)` after its transaction commits, then **re-fetches
  the job** (`this.findOne(...)`) before returning — the pre-dispatch snapshot captured
  inside the transaction is stale the moment `dispatchNext` mutates job/step status.
  `transitionJob`/`transitionStep` now delegate to `job-transitions.ts`.
- **`apps/orchestrator/src/jobs/jobs.module.ts`** (edit) — registers
  `JobDispatchService`/`JobResultConsumerService`.
- **`apps/orchestrator/src/app.module.ts`** (edit) — imports `NatsModule` (`@Global()`, so
  only needs importing once here, same as `DbModule`).
- **`apps/orchestrator/package.json`** (edit) — add `@nats-io/transport-node`,
  `@nats-io/jetstream`, `@nats-io/nats-core` (`^3.4.0` each) as runtime dependencies, and
  `@testcontainers/nats` (`^12.1.0`) as a dev dependency (§5).
  **Changed from the plan's `nats` package**: `pnpm add nats` resolves `nats@2.29.3` but
  npm flags it `deprecated: Package moved. Use @nats-io/transport-node from
  https://github.com/nats-io/nats.js` — the client was split into scoped `@nats-io/*`
  packages (core client, jetstream, transport, kv, obj each separate) for v3. Verified by
  installing both and reading the actual installed `.d.ts`/README from each package rather
  than trusting either the deprecation notice or memory, per CLAUDE.md §2.0.
  **Also discovered mid-implementation**: this SDK's server-string parser misidentifies a
  `user:pass@host:port` string as an IPv6 literal (a second `:` in the userinfo trips its
  `isIPV6` heuristic), so credentials can't be embedded in `NATS_URL`. `NatsService` takes
  `NATS_USER`/`NATS_PASS` as separate optional fields instead — unused against the
  unauthenticated local compose broker, needed because the `@testcontainers/nats` module
  defaults to requiring auth (see §5, `.env.example` updated).

### 4. Go worker — stub executor, not real processing yet

- **`workers/internal/dispatch/message.go`** (new) — Go structs mirroring the two JSON
  shapes in §2 (`StepDispatchMessage`, `StepResultMessage`), hand-kept in sync per the §2
  debt note, plus the stream/subject name constants.
- **`workers/internal/dispatch/handler.go`** (new, not in the original plan) —
  `Handle(ctx, js, msg)`: the actual stub-executor logic (unmarshal `StepDispatchMessage`,
  log it, publish a `StepResultMessage` with `status: "complete"` and `outputRef` set to
  `inputRef`, ack the dispatch message; `Term()`s an unparsable message instead of looping
  on it forever). Factored out of `main.go` into `internal/dispatch` — mirroring the TS side's
  `job-result-handler.ts` extraction — specifically so `dispatch_test.go` (§5) can call it
  directly against a real pulled message, independent of `main()`'s process wiring (signal
  handling, consumer setup).
- **`workers/cmd/worker/main.go`** (edit) — connects to NATS (`nats.go` v1.52.0,
  `jetstream` subpackage per the version already pinned in `TASK-scaffold-monorepo.md`),
  self-registers its own durable pull consumer (`"worker-dispatch"`) on
  `plexus.jobs.dispatch` via `CreateOrUpdateConsumer` (natively idempotent on the Go client
  — see §1; the reading side owns its consumer, the orchestrator only owns the stream
  itself), and calls `dispatch.Handle()` per message from a `Consume()` callback. This
  proves the transport and message-shape contract end-to-end without any real image/video
  work; real built-in processors (`image.resize`/`image.convert`/`image.compress` calling
  into libvips/ffmpeg) are explicitly the next task.

### 5. Tests — real Postgres + real NATS via testcontainers, no mocking

- **`apps/orchestrator/test/support/nats-test-broker.ts`** (new) — starts a NATS container
  (`nats:2.14.4-alpine`, JetStream enabled, matching `infra/docker-compose.yml`) via the
  official `@testcontainers/nats@^12.1.0` module (confirmed to exist and match the
  `testcontainers@^12.1.0` major already in use), returns a connected, boot-initialized
  `NatsService` + teardown — same shape as `postgres-test-db.ts`'s `TestDb`. The container
  defaults to requiring auth (`user`/`pass` both `"test"`), which is where the
  `NATS_USER`/`NATS_PASS` addition (see §3) came from.
- **`apps/orchestrator/src/jobs/job-transitions.integration-spec.ts`** (new, not in the
  original plan — see §3's `job-transitions.ts` note) — real Postgres only, no NATS: the
  legal/illegal transition matrix and `NotFoundException` cases moved here from
  `jobs.service.integration-spec.ts` verbatim in spirit, now exercising
  `transitionJobStatus`/`transitionJobStepStatus` directly against manually-inserted
  job/step rows. Keeps slice 1's original guarantee — the state machine itself is testable
  against real Postgres with zero NATS involvement — intact even though `JobsService.create()`
  now has a NATS dependency.
- **`apps/orchestrator/src/jobs/jobs.service.integration-spec.ts`** (edit — slice 1's file,
  not new) — updated for `create()`'s new dispatch side effect: `JobsService` now needs a
  real `JobDispatchService`/`NatsService` to construct, so this suite runs against real
  Postgres **and** real NATS. The "materializes..." test's expectations changed: a freshly
  created job is `RUNNING` with its first step `RUNNING` (not `QUEUED`/`PENDING`), since
  `create()` dispatches synchronously before returning. The full transition-matrix tests
  moved out to `job-transitions.integration-spec.ts` above; what remains here is `create()`/
  `findOne()` coverage plus a light smoke test that `transitionJob`/`transitionStep` still
  delegate correctly.
- **`apps/orchestrator/src/jobs/job-dispatch.integration-spec.ts`** (new) — real Postgres +
  real NATS: creating a job (via `JobsService.create()`) results in the job at `RUNNING`,
  its first step at `RUNNING`, and a consumable `StepDispatchMessage` on
  `plexus.jobs.dispatch` matching the persisted step; a second test confirms step 2's
  dispatch `inputRef` is chained from step 1's persisted `outputRef`. Both tests share one
  durable consumer created in `beforeAll` rather than one each — **discovered
  mid-implementation**: a `WorkQueuePolicy`-retention stream rejects more than one durable
  consumer with an overlapping filter subject, so two per-test consumers on the same literal
  `plexus.jobs.dispatch` subject would conflict.
- **`apps/orchestrator/src/jobs/job-result-consumer.integration-spec.ts`** (new) — two
  `describe` blocks, each with its own Postgres + NATS containers (same `WorkQueuePolicy`
  single-consumer-per-subject constraint as above — a redelivery test needs to control ack
  timing on the *same* `"jobs-results"` durable the running service uses, which isn't
  possible while that service is also live on a shared broker):
  - **Normal flow** (with `JobResultConsumerService` actually running in the background):
    publishing a synthetic `complete` result for a 2-step job's first step advances step 1
    to `COMPLETE` (polled via `findOne`, since processing happens off a background loop) and
    causes step 2 to become `RUNNING`; completing step 2 settles the job `COMPLETE`;
    publishing a `failed` result fails both the step and the job.
  - **Redelivery / "no lost jobs"** (service *not* running; the test binds the
    `"jobs-results"` durable directly with a short `ackWaitMillis`): pull the published
    result, don't ack it (simulated crash), pull again — `redelivered: true` after the ack
    wait elapses — then call `handleStepResult()` directly to process it, and again on a
    third, genuinely-duplicate delivery, asserting neither throws nor double-applies. This
    is the concrete test for CLAUDE.md's "no lost jobs" guarantee at the dispatch layer.
- **`workers/internal/dispatch/dispatch_test.go`** (new) — against a real NATS instance via
  the official `testcontainers-go/modules/nats@v0.43.0` module (confirmed to exist,
  matching the `testcontainers-go@v0.43.0` major already in use): publishing a
  `StepDispatchMessage` to `plexus.jobs.dispatch`, pulling it, and calling `dispatch.Handle()`
  directly results in a matching `StepResultMessage` (`status: "complete"`,
  `outputRef == inputRef`) on `plexus.jobs.results`. (Asserting the dispatch message's ack
  landed server-side via `Consumer.Info()`'s `NumAckPending` proved flaky — `Msg.Ack()` is
  fire-and-forget, not confirmed — so the test instead relies on `Handle()` returning `nil`,
  which only happens after `Ack()` itself returns without error.)

### Explicitly out of scope for this task (deferred to the next slice)

- **Real built-in processor execution** — no ffmpeg/libvips call anywhere; the Go worker
  always reports `complete` immediately regardless of `processor`/`params`. Next task:
  something like `TASK-builtin-processors.md` (resize/convert/compress via libvips/ffmpeg,
  golden-fixture tests per CLAUDE.md §0).
- **Retry/backoff for `FAILED` steps** — still P1 per the spec; a `FAILED` result fails the
  job immediately, same as slice 1's stated scope.
- **SSE/WebSocket progress to the frontend** — Phase 3 per the spec's phasing. This task's
  event stream is orchestrator↔worker only, nothing fans out to a browser yet.
- **Per-processor subject routing / external plugins** — deferred until Phase 4 needs to
  route different processor ids to different consumers (see §1).
- **Branching/parallel dispatch** — `dispatchNext` walks one linear chain, matching Phase
  1's "linear pipelines only" scope; Phase 3's real-DAG work replaces the "one PENDING step
  at a time" logic with parallel dispatch of all steps whose dependencies just completed.

## Porquê

Slice 1 proved the state machine and persistence in isolation, deliberately without NATS in
the picture, so that its own review wasn't tangled up with queue semantics. This slice's job
is narrowly "does a message actually get from the orchestrator to a worker and back, and
does the state machine advance correctly and exactly-once-effectively when it does" — that's
reviewable and testable on its own, same reasoning slice 1 used to exclude NATS in the first
place. Bolting real ffmpeg/libvips execution onto this task would mean a single review has
to validate both transport correctness (subject layout, ack timing, redelivery safety) and
media-processing correctness (golden fixtures, dimension/format assertions) at once — those
are different kinds of bugs with different failure modes, worth separating the same way
slice 1 separated persistence from transport.

The stub-executor choice (worker always replies `complete`, never touches libvips/ffmpeg)
is deliberate, not laziness: CLAUDE.md's "no lost jobs" guarantee and the recipe-fidelity
guarantee are orthogonal concerns. Proving "a message survives a crashed consumer and gets
redelivered" doesn't need real image processing to be meaningful, and building both at once
would make a failing test ambiguous about which guarantee broke.

The hand-duplicated JSON message shape (§2) is a real, acknowledged violation of CLAUDE.md
§4's "no JSON shapes duplicated by hand across the language boundary" rule. It's accepted
here rather than pulled forward because standing up `proto/` and a generated-stub pipeline
(buf, both Go and TS codegen) is real infrastructure work orthogonal to proving the dispatch
loop, and D-1 already scoped `proto/` to Phase 4. Two structurally-identical small structs
kept in sync by hand for one task is a bounded, visible cost; the deferred-register entry
this task adds exists specifically so that cost doesn't quietly become permanent.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/src/db/schema.ts` | edit | add nullable `outputRef` to `jobSteps` |
| `apps/orchestrator/drizzle/migrations/0001_boring_blue_blade.sql` | new | generated by `drizzle-kit generate` for the `outputRef` column |
| `apps/orchestrator/src/nats/nats.module.ts` | new | `@Global()` module |
| `apps/orchestrator/src/nats/nats.service.ts` | new | connection, stream bootstrap, `publish()`/`durableConsumer()` |
| `apps/orchestrator/src/jobs/dispatch-message.ts` | new | `StepDispatchMessage`/`StepResultMessage` TS interfaces |
| `apps/orchestrator/src/jobs/job-transitions.ts` | new (not in original plan) | DB-aware transition primitives, extracted to avoid a `JobsService`↔`JobDispatchService` circular dependency |
| `apps/orchestrator/src/jobs/job-transitions.integration-spec.ts` | new (not in original plan) | state-machine matrix, moved here from `jobs.service.integration-spec.ts`, real Postgres only |
| `apps/orchestrator/src/jobs/job-dispatch.service.ts` | new | `dispatchNext()` — idempotent, advances linear chain, publishes `StepDispatchMessage` |
| `apps/orchestrator/src/jobs/job-result-handler.ts` | new (not in original plan) | `handleStepResult()` — factored out of the consumer service for direct testability |
| `apps/orchestrator/src/jobs/job-result-consumer.service.ts` | new | durable pull consumer on `plexus.jobs.results`, runs `handleStepResult()` in a loop |
| `apps/orchestrator/src/jobs/jobs.service.ts` | edit | `create()` calls `dispatchNext()` post-commit then re-fetches; `transitionJob`/`transitionStep` delegate to `job-transitions.ts` |
| `apps/orchestrator/src/jobs/jobs.module.ts` | edit | register `JobDispatchService`/`JobResultConsumerService` |
| `apps/orchestrator/src/app.module.ts` | edit | import `NatsModule` |
| `apps/orchestrator/package.json` | edit | add `@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/nats-core` (`^3.4.0`); dev dep `@testcontainers/nats` (`^12.1.0`) |
| `.env.example` | edit | add optional `NATS_USER`/`NATS_PASS` |
| `apps/orchestrator/test/support/nats-test-broker.ts` | new | testcontainers NATS bootstrap |
| `apps/orchestrator/src/jobs/jobs.service.integration-spec.ts` | edit | updated for `create()`'s dispatch side effect; now real Postgres + real NATS |
| `apps/orchestrator/src/jobs/job-dispatch.integration-spec.ts` | new | real Postgres + NATS, incl. inputRef-chaining case |
| `apps/orchestrator/src/jobs/job-result-consumer.integration-spec.ts` | new | real Postgres + NATS, incl. redelivery/no-lost-jobs case |
| `workers/internal/dispatch/message.go` | new | Go structs mirroring the JSON message shapes, stream/subject constants |
| `workers/internal/dispatch/handler.go` | new (not in original plan) | `Handle()` — factored out of `main.go` for direct testability |
| `workers/cmd/worker/main.go` | edit | connects to NATS, wires `dispatch.Handle()` into a `Consume()` callback |
| `workers/internal/dispatch/dispatch_test.go` | new | real-NATS round-trip test via `testcontainers-go/modules/nats` |
| `workers/go.mod` / `workers/go.sum` | edit | add `nats.go`, `testcontainers-go`, `testcontainers-go/modules/nats` |
| `docs/90-deferred-register.md` | edit | new `D-xx`: hand-duplicated JSON message shape until `proto/` exists; new `D-xx`: per-processor subject routing deferred until external plugins (Phase 4); new `D-xx`: `nats` npm package is deprecated in favor of scoped `@nats-io/*` packages (v3) — resolved choice, recorded for anyone who searches for the old package name |
| `CLAUDE.md` | edit | none needed — stack table already says "NATS JetStream" without naming a specific client library |
| `docs/plexus-media-pipeline-spec.md` | edit | none — no Open Question resolved by this task |
