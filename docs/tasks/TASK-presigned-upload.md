# TASK-presigned-upload

## Cenário actual

Phase 2 (Editor MVP) is now fully done (`TASK-editor-export.md` closed its last P0 bullet).
Per the spec's `Suggested Phasing`, Phase 3 is next: "Real DAGs + realtime + Apply to
Batch". Its first prerequisite — and the explicit re-evaluation trigger already recorded
for two open deferred items — is object storage / presigned upload:

- `docs/90-deferred-register.md` `D-3`: "Object storage choice (self-hosted MinIO vs.
  managed S3-compatible) — not resolved by [the initial] scaffold... **Re-evaluation
  trigger: start of the Phase 3 task doc that implements presigned upload.**" That's this
  task.
- `D-11`: `image.resize`/`image.convert`/`image.compress` (and every other built-in
  processor) read `inputRef`/write `outputRef` as **literal local filesystem paths** under
  `WORKER_STORAGE_DIR` (`workers/internal/processors/output.go`), not object storage.
  "**Re-evaluation trigger: start of the Phase 3 task doc that implements presigned
  upload** — `output.go`'s local read/write becomes a download-to-temp/upload-result pair
  there."

Concretely, today:

- `apps/orchestrator/src/jobs/dto/create-job.dto.ts`'s `inputRef` is just an opaque
  `@IsString()` — the orchestrator never resolves it into bytes, only threads it through
  Postgres and NATS. `JobDispatchService.dispatchNext()`
  (`apps/orchestrator/src/jobs/job-dispatch.service.ts`) chains a completed step's
  `outputRef` directly into the next step's `StepDispatchMessage.inputRef` — same opaque
  string, no interpretation on the TS side either.
- On the Go side, `workers/internal/dispatch/handler.go`'s `Handle()` calls
  `fn(ctx, in.JobStepID, in.InputRef, in.Params)` where `in.InputRef` is handed straight to
  `vips.NewImageFromFile(inputRef)` / `ffmpeg -i inputRef` by every processor — it must
  already be a path readable on that worker's local disk. `output.go`'s `writeOutput`
  writes results under `WORKER_STORAGE_DIR` and returns that local path as `outputRef`.
  There is **no ingestion path** for a file that didn't already originate on a worker's own
  filesystem — every existing Go test seeds `WORKER_STORAGE_DIR` directly via `t.Setenv` +
  writing fixture bytes (same gap `TASK-editor-export.md` D-37 hit and worked around with
  its own separate synchronous path).
- `apps/web` has no upload/dashboard UI at all (`apps/web/src/app` has only `editor/` and
  `preview-demo/`) — spec P0 "Upload via presigned URL directly to object storage" has
  **no implementation anywhere**, frontend or backend.
- `infra/docker-compose.yml` has `postgres` and `nats` only. No object storage service
  exists in local dev.

This task closes the backend half of that P0 bullet: an orchestrator endpoint that hands
out a presigned PUT URL, workers that actually read/write objects instead of assuming a
shared local filesystem, and MinIO wired into local dev. It deliberately does **not**
build the `apps/web` upload/dashboard page — no such page exists yet, and building one is
a separate, UI-shaped task (it will also want the SSE progress stream, which is a distinct
Phase 3 piece not addressed here). This task is verifiable end-to-end today via `curl`/API
calls and integration tests without it, the same way `TASK-editor-export.md` verified the
render server standalone before any editor UI touched it.

## Mudanças planeadas

### 1. `infra/docker-compose.yml` — add a `minio` service

Single-node MinIO, matching the existing `postgres`/`nats` pattern (one container, named
volume, healthcheck):

```yaml
minio:
  image: minio/minio:latest
  restart: unless-stopped
  command: ["server", "/data", "--console-address", ":9001"]
  environment:
    MINIO_ROOT_USER: plexus
    MINIO_ROOT_PASSWORD: plexus-minio
  ports:
    - "9000:9000" # S3 API
    - "9001:9001" # web console
  volumes:
    - minio-data:/data
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
    interval: 5s
    timeout: 5s
    retries: 10
```

Add `minio-data` to the top-level `volumes:` block. **Decision recorded here** (resolves
`D-3`): self-hosted MinIO, not a managed S3-compatible service — matches the project's
existing local-infra pattern (Postgres/NATS both run this way), needs no external account
for a portfolio project, and is what the spec's stack table already names first
("MinIO / S3-compatible"). Managed S3 stays viable later purely as a deploy-time swap since
both orchestrator and worker only ever talk to the S3-compatible API surface, never to
MinIO-specific admin behaviour.

### 2. `.env.example` — new shared vars

```
# Object storage (infra/docker-compose.yml's local MinIO). Used by both
# apps/orchestrator (presigning) and the Go worker (upload/download) — see
# docs/tasks/TASK-presigned-upload.md.
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=plexus
MINIO_SECRET_KEY=plexus-minio
MINIO_BUCKET=plexus
MINIO_USE_SSL=false
```

Note inline (and in `D-3`'s resolution) that `MINIO_ENDPOINT` must be reachable from
whatever issues the presigned PUT request (today: `curl`/tests running on the host,
eventually: the user's browser) — this is why it's `localhost:9000`, not a Docker-internal
hostname, and why containerizing the orchestrator/worker later (`D-16`) will need a
public/internal split. Filed as new `D-39` (see below), not solved here.

### 3. `workers/internal/storage` (new package) — MinIO client wrapper

- `New() (*Client, error)` — reads `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/
  `MINIO_BUCKET`/`MINIO_USE_SSL` from env, constructs a `github.com/minio/minio-go/v7`
  client (`minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(...), Secure:
  useSSL})`), and ensures the bucket exists (`BucketExists` + `MakeBucket` if not) —
  mirrors `output.go`'s existing `os.MkdirAll` "create the directory if it doesn't exist"
  behaviour, just against a bucket instead.
- `Download(ctx, objectKey string) (localPath string, cleanup func(), err error)` —
  `GetObject` streamed to a temp file (`os.CreateTemp` under the existing
  `WORKER_STORAGE_DIR`, not `/tmp`, so it stays on the same volume as processor output in
  containerized deploys). `cleanup()` removes it; callers `defer cleanup()`.
- `Upload(ctx, localPath, objectKey string) error` — `PutObject` from the local file, with
  `Content-Type` best-effort from `output.go`'s existing extension map (reused, not
  duplicated).
- Go client choice: `github.com/minio/minio-go/v7` — MinIO's own canonical Go SDK, not
  the generic `aws-sdk-go-v2/service/s3` — checked live (per `CLAUDE.md` §2.0) because the
  AWS SDK v3 (its JS counterpart, checked for §4 below) has documented signature-mismatch
  issues against MinIO; using MinIO's own SDK on both the Go and TS sides sidesteps that
  class of bug entirely rather than hand-verifying compatibility.
- Tested via `github.com/testcontainers/testcontainers-go/modules/minio` (already how
  `dispatch_test.go` gets a real NATS instance — same no-mocking rule, same tool family)
  — added to `workers/go.mod`.

### 4. `workers/internal/dispatch/handler.go` — wrap `Handle()` with download/upload

`Handle()` currently passes `in.InputRef` straight to `fn()` and republishes whatever local
path `fn()` returns as `outputRef`. Changed to:

1. `localIn, cleanup, err := storageClient.Download(ctx, in.InputRef)` — `in.InputRef` is
   now always an object key, never a bare local path. `defer cleanup()`.
2. Call `fn(ctx, in.JobStepID, localIn, in.Params)` exactly as today — **no processor
   changes**. This is the same "confine the new I/O to one boundary layer" shape
   `TASK-editor-export.md` used for `render.RunRecipe`, not a rewrite of every processor.
3. On success, `objectKey := fmt.Sprintf("steps/%s%s", in.JobStepID, ext)` (ext from the
   local output path, mirroring `output.go`'s existing `<jobStepID>.<ext>` naming) and
   `storageClient.Upload(ctx, localOut, objectKey)`; `out.OutputRef = objectKey`.
4. The local output file itself (written by `fn()` under `WORKER_STORAGE_DIR`) is removed
   after a successful upload — object storage is now the durable copy, keeping a
   worker-local one around forever would leak disk across restarts.

`storageClient` constructed once in `cmd/worker/main.go` (`storage.New()`, alongside the
existing `processors.Startup()`) and threaded into `dispatch.Handle` as a parameter —
mirrors how `js jetstream.JetStream` is already passed in rather than made a package
global.

### 5. `apps/orchestrator/src/upload/` (new module) — presign endpoint

- `upload.service.ts` — wraps the official `minio` npm package (not `@aws-sdk/client-s3`;
  same signature-mismatch reasoning as §3, checked live per `CLAUDE.md` §2.0). Reads the
  same `MINIO_*` env vars. `ensureBucket()` called on module init (`OnModuleInit`), same
  idempotent create-if-missing behaviour as the Go side.
  - `presignUpload(filename: string, contentType: string): Promise<{ objectKey: string;
    uploadUrl: string }>` — `objectKey = `uploads/${randomUUID()}-${sanitize(filename)}``,
    `presignedPutObject(bucket, objectKey, expirySeconds)` (15 min expiry).
  - `presignDownload(objectKey: string): Promise<{ downloadUrl: string }>` —
    `presignedGetObject`, same expiry. Generic (not job-specific) so it covers both a
    step's `outputRef` and, later, any other stored object — kept in this module rather
    than bolted onto `jobs.controller.ts`.
- `upload.controller.ts` — `POST /uploads/presign` (`{ filename, contentType }` →
  `{ objectKey, uploadUrl }`), `GET /uploads/presign-download?key=` (→ `{ downloadUrl }`).
  Client uploads/downloads directly against MinIO with the returned URL — the orchestrator
  never proxies file bytes, per spec P0 ("no proxying large files through the API").
- `upload.module.ts`, registered in `app.module.ts` alongside the existing modules.
- No `CreateJobDto` change — `inputRef` stays an opaque string; it's just now expected to
  be an `objectKey` obtained from `presignUpload` rather than a raw filesystem path. Same
  shape, new convention, documented in the DTO's existing comment.

### 6. Tests

- `workers/internal/storage/storage_test.go` — real MinIO via testcontainers: upload then
  download round-trips bytes; download of a missing key errors.
- `workers/internal/dispatch/dispatch_test.go` — updated to seed the input fixture into a
  real MinIO testcontainer (object key, not a `WORKER_STORAGE_DIR` file) and assert the
  result's `OutputRef` is a real, fetchable object — no mocking, per `CLAUDE.md` §0/§4.
- `apps/orchestrator/src/upload/upload.service.integration-spec.ts` — real MinIO via
  `@testcontainers/minio` (added to `apps/orchestrator/package.json` devDependencies,
  matching the existing `@testcontainers/postgresql`/`@testcontainers/nats` pattern):
  presign a PUT, actually `fetch()` a PUT against the returned URL, then presign and
  `fetch()` a GET, assert the round-tripped bytes match.
- `apps/orchestrator/src/upload/upload.controller.integration-spec.ts` — HTTP-level, same
  style as `export.controller.spec.ts` (against the real service backed by the
  testcontainer, not a mock). Named `.integration-spec.ts` rather than `.spec.ts` as
  originally planned here — unlike `export.controller.spec.ts` (which only needs a fake
  local HTTP server), this test needs a real MinIO container, so it has to follow the
  repo's established fast-vs-infra test naming split (`jobs.service.integration-spec.ts`
  etc.) or `pnpm test` would unexpectedly require Docker.

### 7. Docs

- `docs/90-deferred-register.md`: move `D-3` and `D-11` to Resolved with today's date and
  what was decided (self-hosted MinIO; download-to-temp/upload-result wrapper in
  `dispatch.Handle`). Add new `D-39`: presigned-URL endpoints currently assume the caller
  (today: `curl`/tests, eventually: the browser) and the orchestrator/worker all resolve
  `MINIO_ENDPOINT` to the same reachable host (`localhost:9000`) — true only because
  nothing in this stack is containerized yet (`D-16`'s same gap). Once orchestrator/worker
  run inside Docker, presigned URLs handed to a browser will need a public endpoint distinct
  from the internal one those services use to reach MinIO directly. Re-evaluation trigger:
  whichever task first containerizes the orchestrator/worker for real (`D-16`), or the
  `apps/web` upload/dashboard task if it lands first and hits this directly.
- `docs/plexus-media-pipeline-spec.md`: mark the P0 "Upload via presigned URL directly to
  object storage" bullet's backend half done, same style as the Crop/Editor-export
  Open-Questions annotations — note the `apps/web` upload UI is still open (separate task).
- `CLAUDE.md`: no architecture/stack change (MinIO was already the named choice) — no edit
  needed beyond what the register/spec updates cover.

## Porquê

This is the explicit, already-recorded entry point into Phase 3 (`D-3`/`D-11`'s
re-evaluation triggers both name it directly), and it's a hard prerequisite for everything
else Phase 3 needs: "Apply to Batch" has to get many real files into the pipeline somehow,
and the realtime/SSE progress work is far more meaningful to demo against jobs processing
real uploaded files than fixture paths pre-placed on a worker's disk. Doing it now, scoped
tightly to backend + infra, keeps this task independently verifiable and demoable (per
`CLAUDE.md`'s "each phase/task should be independently demoable" spirit already used for
Phase 2) without bundling in the `apps/web` dashboard UI, which is a large enough surface
(upload progress, a file list, pipeline selection) to deserve its own task doc and its own
alignment pass — bundling it here would repeat the mistake `CLAUDE.md` §1 warns about of a
"small" task hiding assumptions, at several times the size.

Choosing MinIO's own SDKs (`minio-go`/`minio` npm) over the generic AWS SDK on both sides
is a direct application of `CLAUDE.md` §2.0 ("check current docs/live behaviour, don't
guess") — live research surfaced real, current GitHub issues of AWS SDK v3 presigned PUT
URLs failing against MinIO with `SignatureDoesNotMatch`, which the MinIO-native SDKs simply
don't hit.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `infra/docker-compose.yml` | edit | add `minio` service + `minio-data` volume |
| `.env.example` | edit | add `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/`MINIO_BUCKET`/`MINIO_USE_SSL` |
| `workers/internal/storage/storage.go` | new | MinIO client wrapper: `New`, `Download`, `Upload` |
| `workers/internal/storage/storage_test.go` | new | real-MinIO testcontainer round-trip tests |
| `workers/internal/dispatch/handler.go` | edit | `Handle()` downloads input object, uploads output object |
| `workers/internal/dispatch/dispatch_test.go` | edit | seed/assert against real MinIO objects instead of local `WORKER_STORAGE_DIR` files |
| `workers/cmd/worker/main.go` | edit | construct `storage.Client`, pass into `dispatch.Handle` |
| `workers/go.mod` / `go.sum` | edit | add `github.com/minio/minio-go/v7`, `github.com/testcontainers/testcontainers-go/modules/minio` |
| `apps/orchestrator/src/upload/upload.module.ts` | new | registers controller + service |
| `apps/orchestrator/src/upload/upload.service.ts` | new | `presignUpload`/`presignDownload`/`ensureBucket` via `minio` npm client |
| `apps/orchestrator/src/upload/upload.controller.ts` | new | `POST /uploads/presign`, `GET /uploads/presign-download` |
| `apps/orchestrator/src/upload/upload.service.integration-spec.ts` | new | real MinIO via `@testcontainers/minio`, real `fetch()` PUT/GET round-trip |
| `apps/orchestrator/src/upload/upload.controller.integration-spec.ts` | new | HTTP-level test against the real service (renamed from the originally planned `.spec.ts` — needs real MinIO, see Mudanças planeadas §6) |
| `apps/orchestrator/src/app.module.ts` | edit | register `UploadModule` |
| `apps/orchestrator/src/jobs/dto/create-job.dto.ts` | edit | update `inputRef`'s doc comment: now an object storage key, not a raw path |
| `apps/orchestrator/package.json` | edit | add `minio` dependency; add `@testcontainers/minio` devDependency |
| `docs/90-deferred-register.md` | edit | resolve `D-3`, `D-11`; add new `D-39` |
| `docs/plexus-media-pipeline-spec.md` | edit | mark presigned-upload P0 bullet's backend half done |
