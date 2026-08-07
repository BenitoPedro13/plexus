# TASK: Heartbeat long-running steps to stop duplicate concurrent processing

## Cenário actual

`workers/cmd/worker/main.go` creates the `worker-dispatch` durable consumer with
`jetstream.ConsumerConfig{Durable: "worker-dispatch", AckPolicy: AckExplicitPolicy,
DeliverPolicy: DeliverAllPolicy, FilterSubject: dispatch.DispatchSubject}` — no `AckWait` is
set, so JetStream applies its server default of **30s** (confirmed live against the running
dev stack: `curl :8222/jsz?consumers=true` on `worker-dispatch` reports `"ack_wait":
30000000000`, i.e. 30,000,000,000ns = 30s). `MaxDeliver` is also left at its default (`-1`,
unlimited).

`workers/internal/dispatch/handler.go`'s `Handle()` receives a message, runs `runStep()`
(download input → run the registered processor → upload output) to completion, and only
then calls `msg.Ack()`. Nothing in between ever calls `msg.InProgress()` — confirmed via
`grep -rn InProgress workers`, zero hits. `jetstream.Msg.InProgress()` exists precisely to
tell the server "still working, don't redeliver yet" (confirmed against the installed
`nats-io/nats.go/jetstream` package's own `Msg` interface doc comment) and is simply never
called.

**Observed failure, live**: quick-actions job `74f61f19-4f8d-4a96-8eb8-2b2eabf7ad47`
(`video.transcode`, `{"format":"mp4","quality":75}`, 1 step) went `RUNNING`→`COMPLETE` in
Postgres from `2026-08-07 22:10:40` to `2026-08-07 22:17:39` — **~7 minutes** for a single
transcode step the user confirmed runs far faster than that with `ffmpeg` invoked directly
on the same machine outside the worker. The input is already downloaded to local disk before
the processor runs (`runStep()`, `handler.go:85`), so this isn't network-bound — it's
CPU-bound encode time being multiplied.

Any processor step whose real work exceeds 30 wall-clock seconds — routine for video
transcode/compress, easy for a large image batch too — crosses the `AckWait` deadline while
`runStep()` is still running. JetStream then assumes the worker died and redelivers the same
dispatch message. `consumer.Consume()`'s callback fires again for the redelivered copy,
calling `dispatch.Handle()` a second time **while the first call is still in flight**,
spawning a second concurrent `runStep()` → a second concurrent `ffmpeg`/`libvips` invocation
of the *same* step, competing for the same CPU cores as the first. With `MaxDeliver: -1` and
no heartbeat, this repeats roughly every 30s for as long as the step keeps running, so a step
that would take, say, 90s alone can end up with 2-4 duplicate encodes stacked on top of each
other, each slowing all the others down — which compounds, it doesn't just add up linearly.
This is the direct cause of the reported "7 minutes is absurd" — the user wasn't watching one
slow encode, they were watching several duplicate encodes fighting over the CPU.

This does not corrupt final job state today only by coincidence: each duplicate run
independently re-uploads to the same deterministic `objectKey`
(`steps/<jobStepID><ext>`, `handler.go:97`) and republishes a `StepResultMessage`; the
orchestrator's `handleStepResult` (`apps/orchestrator/src/jobs/job-result-handler.ts:35-58`)
already treats a second COMPLETE transition on an already-COMPLETE step as
`IllegalTransitionError` and no-ops it. So the *damage* observed today is 100% wasted
CPU/wall-clock time, not incorrect final data — but it's fragile luck, not a designed
safeguard, and it directly contradicts the spec's "no lost jobs" guarantee's implicit twin:
a live worker's job should not be treated as dead and duplicated just because it's still
legitimately busy.

## Mudanças planeadas

1. **`workers/internal/dispatch/handler.go`** — `Handle()` starts a heartbeat goroutine
   immediately after unmarshalling the message and before calling `runStep()`: a ticker
   calling `msg.InProgress()` on an interval well under `AckWait` (10s, given the 2-minute
   `AckWait` set in change 2 below — plenty of margin, still cheap). The goroutine is
   stopped (via a `done` channel, `defer close(done)` around the `runStep()` call) once
   `runStep()` returns, before `Ack()`/publishing the result — so it never fires after the
   message is already terminally handled. `InProgress()` errors are logged, not fatal (a
   missed heartbeat tick that self-heals on the next tick shouldn't fail an otherwise
   in-progress job).
2. **`workers/cmd/worker/main.go`** — the `worker-dispatch` consumer's `ConsumerConfig`
   gains an explicit `AckWait: 2 * time.Minute`. This is defense-in-depth, not the primary
   fix: even with the heartbeat, a longer base window means a brief hiccup (GC pause,
   scheduler jitter) doesn't immediately trigger a false redelivery. `MaxDeliver` stays at
   its unlimited default deliberately — a worker that actually crashes mid-job must still
   have that job picked up by another replica (spec failure-handling requirement, CLAUDE.md
   §0 "no lost jobs"); this task narrows the false-positive redelivery window, it does not
   remove the real one.
3. **`workers/internal/dispatch/dispatch_test.go`** — new
   `TestHandle_NoDuplicateDeliveryDuringLongStep`: publishes a dispatch message for a
   processor that deliberately runs longer than a short test-only `AckWait` (achieved by
   creating a second, short-`AckWait` (e.g. 2s) consumer in the test broker rather than
   changing any production default), and asserts `Handle()`'s registered processor function
   is invoked exactly once even though the `AckWait` window elapses mid-run — proving the
   heartbeat, not luck, is what prevents the redelivery. Real NATS via testcontainers, per
   the existing pattern in this file and CLAUDE.md's no-mocking-the-queue rule; no new test
   infra needed.

## Porquê

This is a correctness/performance bug, not a tuning knob: JetStream's default `AckWait`
(30s) is a reasonable default for typical fast message-processing workloads, but this
worker's whole job is running `ffmpeg`/`libvips` operations that can legitimately take
minutes (per spec: media processing is explicitly the CPU-bound, potentially slow half of
this system — that's the entire reason it's a separate Go worker pool and not inline in the
orchestrator). Never calling `InProgress()` means the worker never told JetStream it was
still alive, so the system's own redelivery safety net (there to satisfy "no lost jobs")
was firing against a worker that was never actually dead. Fixing this directly resolves the
user-reported "why is this 7 minutes when it's fast on my Mac" — the underlying encode was
never the problem; running it multiple times at once was.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `workers/internal/dispatch/handler.go` | edit | heartbeat goroutine calling `msg.InProgress()` for the duration of `runStep()` |
| `workers/cmd/worker/main.go` | edit | explicit `AckWait: 2 * time.Minute` on the `worker-dispatch` consumer config |
| `workers/internal/dispatch/dispatch_test.go` | edit | new test proving no duplicate `Handle()` invocation across an elapsed `AckWait` window |
| `docs/90-deferred-register.md` | edit | log this as a resolved finding (default `AckWait` unsuited to long-running media steps) so it isn't silently rediscovered later |
