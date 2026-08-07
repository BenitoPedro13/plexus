# Plexus

**A general-purpose, extensible media processing engine — a mini Cloudinary /
Zapier-for-media — with a client-side, non-destructive photo editor that feels like Apple
Photos sitting on top of it.**

[![CI](https://github.com/BenitoPedro13/plexus/actions/workflows/ci.yml/badge.svg)](https://github.com/BenitoPedro13/plexus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Upload files, run declarative multi-step pipelines (DAGs of processors like
`resize → watermark → compress → convert`), watch progress in real time, and extend the
system with plugins in any language. On top of that same engine sits an image editor —
direct manipulation, instant WebGPU live preview, curated composite controls — with none
of the job/queue/DAG machinery visible to the person dragging a slider.

## The idea

An **Edit Recipe** — the ordered list of `{ processor, params }` steps behind every edit a
user makes — is *structurally identical* to a pipeline definition. "Edit one photo by hand"
and "define a batch pipeline" are the same data structure, viewed through two different
UIs. That's what makes "edit once, apply to 500 files" nearly free architecturally instead
of a bolted-on feature: the same recipe that previews live in the browser runs, unmodified,
as a batch pipeline on the Go workers.

## Architecture

```
┌──────────┐   presigned    ┌─────────────┐        ┌──────────────┐
│  Next.js │───upload/PUT──▶│   MinIO     │◀───────│   Go worker  │
│  (web)   │                │ (S3 API)    │ download/upload output │
└────┬─────┘                └─────────────┘        └──────┬───────┘
     │ recipe / job requests                               │
     ▼                                                      │
┌──────────────┐   dispatch/results   ┌──────────────┐      │
│ NestJS        │◀────────────────────▶│ NATS         │◀────┘
│ orchestrator  │   (JetStream)         │ JetStream    │  plexus.jobs.dispatch
│ DAG + job     │                       └──────────────┘  plexus.jobs.results
│ state machine │
└──────┬────────┘
       │
       ▼
┌──────────────┐
│  PostgreSQL   │  jobs, pipelines, recipes, plugin registry (Drizzle ORM)
└──────────────┘
```

| Layer | Stack | Why |
|---|---|---|
| Frontend / editor | **Next.js** (TypeScript) — upload, dashboard, live progress | I/O-bound, iteration speed wins |
| Editor live preview | **WebGPU** in-browser (WebGL2/Canvas2D fallback) | Instant feedback on every slider drag — no server round-trip |
| Orchestrator | **NestJS** (TypeScript) — auth, DAG resolution, job state machine | I/O-bound coordination, not CPU-bound work |
| Worker pool | **Go** — ffmpeg/libvips-backed built-in processors | CPU-bound, horizontally scalable, real per-worker memory/concurrency control |
| Final export / batch render | Go — the same recipe executed server-side at full resolution | One execution engine backs both the live preview (approximately) and the export (exactly) |
| Plugin contract | **gRPC (protobuf)** | Language-agnostic — a plugin author can write theirs in anything |
| Queue + event bus | **NATS JetStream** | One piece of infra for both job dispatch and the realtime progress stream |
| Data | **PostgreSQL** via **Drizzle ORM** | SQL-first; leaves room for a future PostGIS-backed photo-GPS/map view |
| Objects | **MinIO** (S3-compatible) | Presigned-URL upload/download — the API never proxies large files |

The Go/TypeScript split is architecturally load-bearing: TypeScript where work is I/O-bound
and iteration speed wins (frontend, orchestrator), Go where work is CPU-bound and
per-worker memory/concurrency matter (processors, export).

Full design rationale, requirements, and open questions live in
[`docs/plexus-media-pipeline-spec.md`](docs/plexus-media-pipeline-spec.md).

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 — Core pipeline engine | Orchestrator + Go worker + Postgres + NATS, linear pipelines, built-in resize/convert/compress/video/audio processors | ✅ Done |
| 2 — Editor MVP | Non-destructive recipe model, WebGPU/WebGL2 live preview, curated composite sliders (Light/Color/B&W/Sharpen/Crop), synchronous export | ✅ Done |
| 3 — Real DAGs + realtime + Apply to Batch | Object storage/presigned upload, shared recipe package, SSE progress stream, batch dispatch | 🚧 In progress |
| 4 — Plugin system | gRPC plugin contract + registry, one real external plugin | ⏳ Not started |

Every non-trivial change goes through a task doc in [`docs/tasks/`](docs/tasks) before any
code is written, and every deferred decision, unverified claim, or piece of intentional
debt is tracked in [`docs/90-deferred-register.md`](docs/90-deferred-register.md) — both
described in [`CLAUDE.md`](CLAUDE.md), which also doubles as this repo's contributor
workflow guide.

## Things that must not break

- **Non-destructive editing** — nothing is ever "applied" to pixels until export. Every
  editor control writes recipe parameters; undo/redo is recipe history.
- **Recipe/pipeline unification** — a recipe built by hand on one image runs *unmodified*
  as a batch pipeline across many files. No "convert my edit into a pipeline" step.
- **No lost jobs** — a worker killed mid-job doesn't lose the job; another replica picks it
  up.

## Getting started

**Prerequisites:** Node 24 (`.nvmrc`), pnpm, Go 1.26+, Docker, [libvips](https://www.libvips.org/) 8.14+, and ffmpeg — see
[`workers/README.md`](workers/README.md) for OS-specific install commands.

```sh
git clone https://github.com/BenitoPedro13/plexus.git
cd plexus
cp .env.example .env          # Postgres/NATS/MinIO connection info
cd apps/web && cp .env.example .env.local && cd ../..
pnpm install

pnpm dev
```

`pnpm dev` is the one command that brings up the whole stack: local infra (Postgres, NATS
JetStream, MinIO — waits for all three to report healthy), the orchestrator at
`http://localhost:3000`, the Go worker, and the editor/frontend at
`http://localhost:3001` (bumped from Next's default 3000 to avoid colliding with the
orchestrator). It loads the repo-root `.env` and exports it to every process it starts —
see `scripts/dev.sh`.

<details>
<summary>Running pieces individually</summary>

Useful when debugging one process in isolation. Each of these needs the repo-root `.env`
exported into its own shell first (`main.ts`/`main.go` don't load it automatically —
`docs/90-deferred-register.md` `D-43`):

```sh
set -a && source .env && set +a

# Local infra: Postgres, NATS JetStream, MinIO
docker compose -f infra/docker-compose.yml up --wait

# Orchestrator (NestJS) — http://localhost:3000
pnpm --filter orchestrator start:dev

# Go worker
cd workers && go run ./cmd/worker

# Editor / frontend — pick a port that doesn't collide with the orchestrator's 3000
cd apps/web && pnpm dev -p 3001
```

</details>

Each app has its own README with endpoints, env vars, and test instructions:
[`apps/orchestrator/README.md`](apps/orchestrator/README.md),
[`workers/README.md`](workers/README.md), [`apps/web/README.md`](apps/web/README.md).

## Project structure

```
apps/web            Next.js frontend + WebGPU/WebGL2 editor
apps/orchestrator    NestJS — auth, DAG resolution, job state machine
workers/             Go worker pool — built-in processors, export/batch render
packages/recipe      shared Zod recipe/pipeline step schema — used by apps/web + apps/orchestrator
infra/               docker-compose.yml — local Postgres, NATS JetStream, MinIO
docs/                spec, task docs, deferred register
```

`proto/` (gRPC plugin contract) is proposed but not yet scaffolded — it lands in its own
task doc when Phase 4 actually starts, per
[`docs/90-deferred-register.md`](docs/90-deferred-register.md) `D-1`.

## Testing

Orchestrator and worker tests run against **real infrastructure via testcontainers** — real
Postgres, real NATS JetStream, real MinIO. Mocking the database or the queue is banned in
the orchestrator's domain logic and the Go workers, by design (see `CLAUDE.md`).

```sh
# Orchestrator
cd apps/orchestrator && pnpm test

# Go workers
cd workers && go test ./...

# Editor
cd apps/web && pnpm test
```

## License

[MIT](LICENSE)
