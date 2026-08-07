> **Superseded** — the user asked for a full declarative test suite across every
> orchestrator endpoint, not just this one smoke check. See
> `TASK-orchestrator-http-userflow-tests.md`, which covers this same fan-out+SSE flow
> (`dag-fan-out.http`) using httpyac instead of a standalone curl script. No code was
> written from this doc; left here for the design-decision history (why curl was the
> initial pick, and why it was superseded rather than silently abandoned).

# TASK: manual smoke-test script for branching DAG dispatch + SSE

## Cenário actual

Branching/parallel DAG pipelines (commit `5b6d667`) are covered by 51 automated tests in
`apps/orchestrator` running against real Postgres/NATS via testcontainers
(`pipelines.service.integration-spec.ts`, `job-events.integration-spec.ts`). Those tests
are the correctness authority, but two things they don't give anyone:

1. A way to poke at the **real HTTP surface** by hand while running `pnpm dev` locally.
   Several of the integration tests call `PipelinesService.create()` / `JobsService`
   directly and pass `params: {}` fixtures — that bypasses the global `ValidationPipe`
   (`whitelist/transform/forbidNonWhitelisted`, `apps/orchestrator/src/main.ts:9-15`) and
   the Zod-backed `ValidateProcessorParams` decorator
   (`apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts:38-70`) that the real
   `POST /pipelines` route enforces. `params: {}` for `image.resize`/`image.compress` would
   be **rejected** over real HTTP.
2. A visible, human-readable tail of the `GET /jobs/:id/events` SSE stream to eyeball that
   fan-out steps (`root → a`, `root → b`) actually interleave/complete independently, and
   that the stream closes cleanly on a terminal job status (`COMPLETE` | `FAILED` |
   `PARTIAL`).

No such script exists today (`scripts/` only has `dev.sh`). This was raised by the user
asking how to manually test the branching DAG work beyond the automated suite, and
specifically whether Postman or a browser extension would help — Postman's classic request
mode buffers until the response completes, which doesn't work for a stream that stays open
until job completion; `curl -N` disables curl's own output buffering and prints each SSE
`data:` line as it arrives, with zero extra tooling.

## Mudanças planeadas

**New file: `scripts/smoke/dag-fan-out.sh`** (bash, `curl` + `jq`, no new language/tooling
dependency — both already assumed present for local dev per `scripts/dev.sh` conventions).

Behavior:

- Reads `ORCHESTRATOR_URL` (default `http://localhost:3000`).
- `POST /pipelines` with a fan-out pipeline using **schema-valid params** (real request,
  not an integration-test fixture):
  ```json
  {
    "name": "fan-out-smoke-<timestamp>",
    "steps": [
      { "id": "root", "processor": "image.resize", "params": { "width": 800, "height": 600 } },
      { "id": "a", "processor": "image.compress", "params": { "quality": 80 }, "dependsOn": ["root"] },
      { "id": "b", "processor": "image.convert", "params": { "format": "webp" }, "dependsOn": ["root"] }
    ]
  }
  ```
- `POST /jobs` with the returned pipeline id and a placeholder `inputRef` (opaque string per
  `CreateJobDto`, not validated against object storage at creation time).
- `curl -N` the returned job's `GET /jobs/:id/events`, piping each `data:` line through `jq`
  to print `scope`/`status`/`stepId` compactly as events arrive.
- Exit codes: `0` if the stream reaches `COMPLETE` or `PARTIAL`, `1` if it reaches `FAILED`
  or the connection closes without a terminal status, `2` for setup failures (missing
  `curl`/`jq`, pipeline/job creation request failing).

This is a **manual, local-only tool** — it requires a live `pnpm dev` stack (Postgres, NATS,
MinIO, orchestrator, a Go worker actually processing jobs) and is not wired into
`pnpm test` or CI. It complements, and does not replace, the testcontainer-based automated
suite, which remains the correctness authority per `CLAUDE.md`'s no-mocking rule.

**Edit: `README.md`** — add one short paragraph + command under the existing `## Testing`
section (`README.md:156-171`) pointing at the new script as the manual/E2E complement to
the automated suite, so it doesn't go undiscovered.

Alternatives considered: Postman/Newman collection — rejected, see Porquê. A Node/TS script
using `EventSource` — rejected as unnecessary weight; curl/jq needs no new dependency and
matches the project's "use the CLI, don't hand-roll" preference (`CLAUDE.md` §2).

## Porquê

The user wants a repeatable way to manually verify branching-DAG dispatch and the SSE
progress stream against a real running stack, distinct from (not a replacement for) the
automated test suite. curl's `-N` flag is the simplest tool that correctly handles a
long-lived SSE response without buffering or hanging — Postman's default request mode waits
for the response to close before rendering anything, which never happens until the job
finishes, and its EventSource-specific mode is a separate, non-default request type. A
checked-in script also documents, in one place, the exact schema-valid request shapes
(`params` per `@plexus/recipe`'s Zod schemas, `dependsOn` conventions) needed to hit the
real HTTP API by hand — useful for anyone poking at the orchestrator manually, not just for
this one verification.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `scripts/smoke/dag-fan-out.sh` | new | bash smoke script: `POST /pipelines` (fan-out), `POST /jobs`, `curl -N` SSE tail, pass/fail on terminal job status |
| `README.md` | edit | add manual smoke-test pointer under `## Testing` |
