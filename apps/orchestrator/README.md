# Plexus orchestrator

NestJS service handling pipeline DAG resolution and the job state machine — the
coordination layer between `apps/web` and the Go worker pool (`workers/`). See
[`docs/plexus-media-pipeline-spec.md`](../../docs/plexus-media-pipeline-spec.md) and the
root [`README.md`](../../README.md) for the full architecture.

It never touches media bytes directly: large files move via presigned MinIO URLs, and step
execution happens in the Go workers over NATS JetStream.

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /pipelines` | Create a pipeline (a `Recipe`'s `steps`, unmodified — this is the concrete proof that an editor recipe and a batch pipeline are the same data structure) |
| `GET /pipelines/:id` | Fetch a pipeline |
| `POST /jobs` | Create and dispatch a job for a pipeline against one `inputRef` (an object-storage key from `POST /uploads/presign`) |
| `POST /jobs/batch` | Create and dispatch one job per `inputRef` (`{ pipelineId, inputRefs: string[] }`) against the same pipeline — the editor's Apply to Batch flow |
| `GET /jobs/:id` | Fetch a job and its per-step status |
| `GET /jobs/:id/events` | Server-Sent Events stream of live job/step progress — a DB snapshot first, then incremental events until the job settles (`TASK-realtime-progress-sse.md`) |
| `POST /uploads/presign` | Presigned MinIO PUT URL for uploading a file directly to object storage |
| `GET /uploads/presign-download` | Presigned MinIO GET URL for downloading an object (e.g. a completed step's output) |
| `POST /export` | Synchronous single-image render, proxied to the Go render server (`workers/cmd/renderserver`) — the editor's export path, distinct from the async job pipeline above |

## Env vars

See [`.env.example`](../../.env.example) at the repo root — this app reads `DATABASE_URL`,
`NATS_URL`/`NATS_USER`/`NATS_PASS`, `PORT`, `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/
`MINIO_SECRET_KEY`/`MINIO_BUCKET`/`MINIO_USE_SSL`, `RENDER_SERVER_URL`, and optionally
`CORS_ORIGIN` (comma-separated allow-list; unset reflects any request origin — see
`src/cors.ts` and `docs/90-deferred-register.md` `D-42`).

Note: nothing in `main.ts` loads `.env` into the process automatically (no `dotenv`/
`@nestjs/config`) — export the repo-root `.env` into your shell first, e.g.
`set -a; source ../../.env; set +a` before `pnpm start:dev` (tracked in
`docs/90-deferred-register.md` `D-43` / `docs/tasks/TASK-dev-run-script.md`).

## Run

```sh
pnpm install
pnpm start:dev
```

Requires the local infra stack (`docker compose -f infra/docker-compose.yml up -d` from
the repo root — Postgres, NATS JetStream, MinIO) and a running `workers/cmd/renderserver`
for `/export`.

## Test

```sh
pnpm test        # unit + integration specs
pnpm test:cov     # with coverage
```

`*.integration-spec.ts` files run against **real Postgres/NATS/MinIO via testcontainers**
(Docker required) — mocking the database or the queue is banned in this app's domain logic,
per the repo root [`CLAUDE.md`](../../CLAUDE.md).

## Migrations

```sh
pnpm exec drizzle-kit generate   # generate a migration from schema.ts changes
```

Migrations live in `drizzle/migrations` and are applied via `drizzle-orm/node-postgres`'s
migrator, both at app startup and in test setup (`test/support/postgres-test-db.ts`).
