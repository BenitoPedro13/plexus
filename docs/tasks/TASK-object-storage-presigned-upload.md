# TASK: Object storage + presigned upload (resolves D-3, D-11)

## Cenário actual

Nothing in the codebase talks to object storage. Every "file" the system knows about is a
literal path on whichever machine wrote it:

- `apps/orchestrator/src/db/schema.ts`'s `jobs.inputRef` and `jobSteps.outputRef` are plain
  `text` columns holding local filesystem paths (see the schema's own comment: "Opaque
  input location for Phase 1 ... Object storage / presigned upload wiring is deferred to
  Phase 3").
- `workers/internal/processors/output.go`'s `writeOutput`/`outputPath` write every
  processor's result under `$WORKER_STORAGE_DIR` (default `./data/worker-output`) on the
  worker's own disk. Multiple worker replicas sharing this today only works because local
  dev runs one replica against one shared bind-mounted directory — it does not survive a
  real horizontally-scaled deployment, where step N's output written by replica A would be
  invisible to replica B picking up step N+1.
- `apps/orchestrator/src/jobs/dto/create-job.dto.ts`'s `CreateJobDto` almost certainly takes
  `inputRef` as a caller-supplied string today — there is no upload endpoint at all, so a
  client must already have a path the worker process can read, which only works for local
  dev with everything on one machine.
- `workers/cmd/renderserver`'s `POST /render` (the *separate* synchronous editor-export
  path, `TASK-editor-export.md`) takes the file directly as multipart form data and never
  touches this at all — it stays as-is; this task only affects the async NATS
  job-dispatch path.
- `infra/docker-compose.yml` runs local Postgres and NATS only. No object storage service.
- Spec Open Question ("Object storage: self-hosted MinIO ... vs. a managed S3-compatible
  service") is unresolved — `D-3` in the deferred register.

This blocks two P0 spec bullets outright: "Upload via presigned URL directly to object
storage (no proxying large files through the API)" and, transitively, "Apply to Batch"
(`TASK-apply-to-batch.md`, planned next), which needs many files' worth of input actually
reachable by any worker replica.

## Mudanças planeadas

**Decision this task makes (D-3):** self-hosted **MinIO**, not a managed S3-compatible
service. Reasoning goes in the Porquê section below; `docs/90-deferred-register.md` and
this spec's Open Questions section get updated in the same pass per CLAUDE.md §3.

- **`infra/docker-compose.yml`** — new `minio` service (official `minio/minio` image,
  `server /data --console-address ":9001"`, ports `9000`/`9001`, healthcheck against
  MinIO's own `/minio/health/live`, a named volume). `[VERIFY: current-stable `minio/minio`
  tag and healthcheck path against MinIO's own docs before pinning — CLAUDE.md §2.0.]`
- **`.env.example`** — new vars: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`,
  `S3_SECRET_KEY`, `S3_BUCKET` (e.g. `plexus-media`), `S3_FORCE_PATH_STYLE=true` (MinIO
  needs path-style addressing, not virtual-hosted). `WORKER_STORAGE_DIR` gets removed once
  nothing reads it any more — check for other readers first (the render server does not use
  it, per above).
- **`apps/orchestrator/src/storage/` (new module)** — `StorageService` wrapping the AWS SDK
  v3 S3 client (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — the SDK's own
  presigner, not a hand-rolled signature; MinIO is S3-API-compatible so the stock AWS SDK
  works unmodified against it, only the endpoint changes). Two methods:
  `presignUpload(key, contentType)` → `{ url, key }` (PUT presigned URL) and
  `presignDownload(key)` → `url` (GET presigned URL), both short-TTL.
- **`apps/orchestrator/src/jobs/`** — new `POST /jobs/presign-upload` endpoint (returns a
  presigned PUT URL + the `key` the client should then reference) ahead of the existing
  `POST /jobs`. `CreateJobDto.inputRef` becomes the object-storage `key` returned by that
  presign call, not an arbitrary path — validated as belonging to the configured bucket
  prefix, not accepted as a raw arbitrary string. `job-dispatch.service.ts`'s
  `StepDispatchMessage.inputRef`/`outputRef` become object-storage keys end to end (no
  change to its own logic — it already just threads whatever ref the previous step wrote).
- **`workers/internal/storage/` (new Go package)** — thin wrapper over
  `github.com/aws/aws-sdk-go-v2/service/s3` (verify current-stable module path/version per
  CLAUDE.md §2.0 before `go get`), `Download(ctx, key) (localTempPath, error)` and
  `Upload(ctx, localPath, key) error`. `workers/internal/processors/output.go`'s
  `writeOutput`/`outputPath` change from "write straight to `$WORKER_STORAGE_DIR`" to
  "write to a per-invocation temp dir, then `Upload` to object storage, then remove the
  temp file" — every processor's `outputRef` return value becomes an object-storage key,
  not a path. `workers/internal/dispatch/handler.go` (wherever it resolves `inputRef` before
  calling a processor) gains a `Download` call first. `workers/cmd/worker`'s startup reads
  the new `S3_*` env vars alongside its existing `WORKER_STORAGE_DIR`-reading code, which
  gets deleted once nothing else needs it.
- **`apps/web`** — the *editor's* export path (`workers/cmd/renderserver`) is explicitly
  out of scope (see Cenário actual) since it's synchronous and single-image, not part of
  the async job pipeline this task touches. `TASK-apply-to-batch.md` is where `apps/web`
  gets a real multi-file upload UI that calls the new `presign-upload` endpoint — not
  duplicated here.
- **`docs/plexus-media-pipeline-spec.md`** — Open Questions' object-storage bullet updated
  to point at this task and the deferred-register resolution, per CLAUDE.md §3.1.

## Porquê

**Why MinIO over managed S3-compatible (resolves D-3):** every other piece of local
infrastructure in this project is already self-hosted via `infra/docker-compose.yml`
(Postgres, NATS) — there is no managed-service dependency anywhere else, and introducing
one now for object storage alone would mean `docker compose up` no longer boots a complete
local environment by itself, breaking the "one command, fully local" property every other
service in this repo currently has. MinIO exposes the real S3 API, so the AWS SDK client
code written against it is the *same* code a future managed-S3 swap would use — only
`S3_ENDPOINT` changes. This is a config decision, not an architecture one, and reversible
without touching `StorageService`'s or the Go `storage` package's interface.

**Why presigned URLs via the orchestrator, not proxied uploads:** this is the spec's own P0
line verbatim ("no proxying large files through the API"). Routing large binary uploads
through NestJS's request pipeline would burn orchestrator memory/connections on I/O it
doesn't need to touch — the orchestrator's job is issuing a short-lived signed URL and
tracking the resulting key, not moving bytes.

**Why the Go worker downloads to a local temp file rather than streaming through govips/
ffmpeg directly from an S3 reader:** every existing processor (`workers/internal/processors/
*.go`) already assumes a local path in and a local path out (govips's `NewImageFromFile`,
ffmpeg's file arguments) — building streaming I/O into every processor is a much larger,
riskier change than "download once, run the existing processor unmodified, upload once,"
for a benefit (avoiding one extra local disk round-trip per step) that doesn't matter at
this project's scale. This mirrors D-11's own original reasoning: keep the processor
`Func` interface's shape stable, localize the storage swap to the read/write edges.

**Why this unblocks Apply to Batch:** today a "batch" would mean N clients each needing
direct filesystem access to whichever worker replica happens to pick up their job — object
storage is what makes "any replica can process any file" actually true, which is the
concrete mechanism behind the spec's "horizontally scalable Go worker pool" P0 bullet for
anything beyond single-machine local dev.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `infra/docker-compose.yml` | edit | add `minio` service + volume |
| `.env.example` | edit | add `S3_*` vars, remove `WORKER_STORAGE_DIR` once unused |
| `apps/orchestrator/src/storage/storage.module.ts` | new | |
| `apps/orchestrator/src/storage/storage.service.ts` | new | presign upload/download via `@aws-sdk/client-s3` + presigner |
| `apps/orchestrator/src/jobs/jobs.controller.ts` | edit | add `POST /jobs/presign-upload` |
| `apps/orchestrator/src/jobs/dto/create-job.dto.ts` | edit | `inputRef` validated as an object-storage key |
| `apps/orchestrator/package.json` | edit | add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| `workers/internal/storage/storage.go` | new | `Download`/`Upload` via `aws-sdk-go-v2/service/s3` |
| `workers/internal/processors/output.go` | edit | temp-dir write + `Upload`, replaces `$WORKER_STORAGE_DIR` write |
| `workers/internal/dispatch/handler.go` | edit | `Download` before processor dispatch |
| `workers/cmd/worker/main.go` | edit | read new `S3_*` env vars, drop `WORKER_STORAGE_DIR` |
| `workers/go.mod` | edit | add `aws-sdk-go-v2/service/s3` + credentials/config modules |
| `docs/plexus-media-pipeline-spec.md` | edit | mark object-storage Open Question resolved |
| `docs/90-deferred-register.md` | edit | resolve `D-3`; update `D-11`'s trigger as fired |
