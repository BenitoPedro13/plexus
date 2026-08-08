# TASK: Deploy Plexus to Railway

## Update (2026-08-08): `web` domain renamed to `plexus.up.railway.app`

The Railway-generated domain `https://web-production-645b4.up.railway.app` was renamed to
`https://plexus.up.railway.app` via `railway domain update <old> --domain plexus --service web`
for a friendlier URL. Renaming replaces the domain in place — the old hostname now 404s, it
is not kept as an alias. Two dependents were updated in the same pass (see `D-54` in
`docs/90-deferred-register.md`, which is now resolved):

- `orchestrator`'s `CORS_ORIGIN` env var → `https://plexus.up.railway.app`
- The Railway Bucket's CORS policy `AllowedOrigins` → `https://plexus.up.railway.app`
  (via `aws s3api put-bucket-cors`, same command as the original setup)

Verified: `plexus.up.railway.app` returns `200`; the old domain returns `404`; the bucket's
CORS config reflects the new origin (`aws s3api get-bucket-cors`).

## Result (2026-08-08)

Deployed and verified end-to-end. Project `plexus` (id `07ef95d2-51f0-4669-8cdf-f89c96631840`),
environment `production`, workspace `designmainnet-cell's Projects`. Live domains:
`orchestrator` → `https://orchestrator-production-4b12.up.railway.app`, `web` →
`https://web-production-645b4.up.railway.app`. All 6 services healthy; verified via real
HTTP calls, not just deploy-status polling: orchestrator's `/` returns `200`; a real CORS
preflight from `web`'s origin returns the exact origin (not reflection); a presigned
upload round-tripped a real file through the Railway Bucket with virtual-host addressing;
`POST /export` returned a real rendered JPEG, proving the `orchestrator` → `renderserver`
private-network hop works; `worker` logs show `"worker started, consuming
plexus.jobs.dispatch"` with no errors.

The plan below matches what shipped, with three corrections made mid-execution (not
anticipated by the original plan, each fixed and verified — see `docs/90-deferred-register.md`'s
new `D-16 / D-41 / D-42` resolved entry for the full narrative):

1. **`pnpm --filter <name> build` alone doesn't build workspace dependencies first**, contrary
   to this doc's original assumption — `orchestrator`/`web`'s build commands needed to be
   `pnpm --filter @plexus/recipe build && pnpm --filter <name> build` explicitly. (A `pnpm
   --filter ...<name> build` topological-dependency filter was tried first and silently
   selected only `<name>`, not its dependencies, on this pnpm version — not investigated
   further once the explicit two-step command was confirmed working.)
2. **`apps/orchestrator/package.json`'s `start:prod` script (`node dist/main`) was already
   broken**, unrelated to this deploy — `nest-cli.json`'s `sourceRoot: "src"` plus
   `drizzle.config.ts` living outside `src/` makes `tsc` emit to `dist/src/main.js`, not
   `dist/main.js`. Never caught before because local dev only ever uses `start:dev`. Fixed:
   `"start:prod": "node dist/src/main"`.
3. **Two `apps/web` pages needed a `Suspense` boundary around `useSearchParams()`**
   (`quick-actions/page.tsx`, `batch/[pipelineId]/page.tsx`) — Next.js 16.3 rejects this
   outright at `next build`'s static-prerendering step, a pre-existing latent bug never
   hit because nothing had run a production build before. Fixed per Next.js's own current
   docs (`use-search-params.md`): each page now wraps its logic in `<Suspense>`, with an
   in-language fallback (the existing `AppHeader` immediately, plus the app's established
   `Loader2`/`animate-spin` pattern) rather than a blank flash, per the user's request to
   make the fallback state better UX rather than just functionally correct.
4. **The Railway Bucket needed an explicit CORS policy** for the browser's direct presigned
   PUT/GET — not anticipated by the plan below (the `[VERIFY]` item only flagged the
   `pathStyle`/endpoint-format risk, not CORS). Found live: the user hit the exact browser
   CORS error on a real Quick Actions run right after the first working deploy. Fixed via
   `aws s3api put-bucket-cors` against the bucket's own endpoint, scoped to `web`'s exact
   origin (see new README.md Deployment section for the exact command).

The `[VERIFY]` items below resolved as: NATS's `nats-server -js -sd /data -m 8222` start
command works as a Railway image-source `deploy.startCommand` in **exec form** (confirmed
via `docker inspect`/entrypoint-script reading before setting it, not guessed) — Railway's
own docs state the start command replaces `ENTRYPOINT` in exec form for image/Dockerfile
sources, so the full `nats-server ...` invocation (not bare flags) was used, bypassing the
image's own flag-prepending entrypoint logic entirely. The bucket credentials' `endpoint`
field came back as a full `https://` URL (not the `host:port` shape `.env.example` uses
locally) and `urlStyle: "virtual-host"` — handled by stripping the scheme when setting
`MINIO_ENDPOINT` and adding the `MINIO_PATH_STYLE` env var (point 4 above's sibling fix,
same code change) rather than changing `parseEndpoint()`'s parsing logic.

## Cenário actual

Plexus runs only locally today. `infra/docker-compose.yml` provisions three dev-mode
dependencies (`postgres:18.4`, `nats:2.14.4-alpine` with JetStream, `minio/minio` for
object storage), and `pnpm dev` (`scripts/dev.sh`) runs `apps/web` (Next.js 16.3),
`apps/orchestrator` (NestJS), and the Go binaries (`workers/cmd/worker`,
`workers/cmd/renderserver`) as local processes against that compose stack. Nothing is
containerized for any target other than local dev, and nothing is deployed anywhere:

- `workers/Dockerfile` builds `cmd/worker` only (multi-stage `golang:1.26.5-bookworm` +
  `libvips-dev` builder, `debian:bookworm-slim` + `libvips42`/`ffmpeg` runtime). It isn't
  pushed to a registry or wired into any deploy pipeline — `docs/90-deferred-register.md`
  `D-16`.
- `workers/cmd/renderserver` (the synchronous editor-export Go binary) has **no
  Dockerfile at all** — `D-38`.
- All service-to-service config is `localhost`-shaped: `.env.example`'s
  `MINIO_ENDPOINT=localhost:9000`, `NATS_URL=nats://localhost:4222`,
  `DATABASE_URL=postgresql://plexus:plexus@localhost:5432/plexus`,
  `RENDER_SERVER_URL=http://localhost:8090`. Presigned upload/download URLs
  (`apps/orchestrator/src/upload/upload.service.ts`) are generated server-side but used
  directly by the browser (`apps/web/src/lib/editor/batch.ts`,
  `.../export.ts`) — this only works today because orchestrator, worker, and browser all
  resolve `localhost` identically. `D-41` names this exact gap and predicts the fix: "a
  public/internal endpoint split... whichever task first containerizes the
  orchestrator/worker for real."
- `apps/orchestrator`'s CORS policy (`apps/orchestrator/src/cors.ts`) reflects any request
  `Origin` unless `CORS_ORIGIN` is set — `D-42` explicitly defers setting it "to the real
  deployed frontend origin(s)" until something is deployed.
- `apps/web` already reads `process.env.NEXT_PUBLIC_ORCHESTRATOR_URL` (falls back to
  `http://localhost:3000`) in `batch.ts` and `export.ts` — the frontend/orchestrator
  wiring point already exists in code, just unset for any non-local target.
- `apps/orchestrator/src/main.ts` already listens on `process.env.PORT ?? 3000` and
  `apps/orchestrator/src/db/db.service.ts` already takes a single `DATABASE_URL`
  connection string — both are already deploy-target-agnostic, no code change needed
  there.

No registry, hosting platform, or deploy pipeline has been chosen until now (`D-16`).

## Mudanças planeadas

Deploy target: **Railway**, one project (`plexus`), one environment (`production`), in
the `designmainnet-cell's Projects` workspace, six services. Decided with the user via
`AskUserQuestion` before writing this doc (workspace choice; object storage: Railway's
native S3-compatible Bucket over self-hosting the `minio/minio` container — see Porquê).

### Railway infrastructure (provisioned via `railway` CLI/MCP, not files)

| Service | Kind | Notes |
|---|---|---|
| `postgres` | Railway managed Postgres (`railway add --database postgres`) | Auto-generates `DATABASE_URL`; own volume, no action needed |
| `nats` | Docker image `nats:2.14.4-alpine` (source.image, matches compose's pin) | `[VERIFY: exact CMD/entrypoint args for this image tag — confirm `-js -sd /data -m 8222` is the right `deploy.startCommand`, or whether the image's entrypoint already expects bare nats-server flags, before setting it]`. Volume via `railway volume add --service nats --mount-path /data`. No public domain — private network only |
| `plexus` (bucket) | Railway Bucket (`railway bucket create plexus --region iad`) | S3-compatible, public endpoint by default — resolves `D-41` without a public/private split: orchestrator, worker, and the browser all use the same endpoint |
| `orchestrator` | NestJS, Railpack build from repo root | `build.buildCommand = "pnpm --filter orchestrator build"`, `deploy.startCommand = "pnpm --filter orchestrator start:prod"`, public domain |
| `worker` | Go, Dockerfile build (`workers/Dockerfile`, existing) | No public domain — connects to `nats`/`postgres`/bucket privately |
| `renderserver` | Go, Dockerfile build (**new** `workers/Dockerfile.renderserver`) | No public domain — reached by `orchestrator` only, over private network |
| `web` | Next.js, Railpack build from repo root | `build.buildCommand = "pnpm --filter web build"`, `deploy.startCommand = "pnpm --filter web start"`, public domain |

`orchestrator` and `web` use the **shared monorepo** Railway pattern (no `rootDirectory`,
build/start commands scoped with `pnpm --filter`) since both depend on the workspace
package `@plexus/recipe` (`workspace:*`) — an isolated `rootDirectory` per service would
hide that shared package, per the Railway skill's monorepo guidance.

### Env var wiring (set via `railway variable set` / `environment edit`)

| Service | Var | Value |
|---|---|---|
| `orchestrator` | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `orchestrator`, `worker` | `NATS_URL` | `nats://${{nats.RAILWAY_PRIVATE_DOMAIN}}:4222` |
| `orchestrator`, `worker` | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_USE_SSL=true` | From `railway bucket credentials --bucket plexus --json` (`endpoint`, `accessKeyId`, `secretAccessKey`, `bucketName`) — `[VERIFY: exact endpoint host:port shape returned, and whether the bucket's `urlStyle` (path vs virtual-hosted) is compatible as-is with `upload.service.ts`'s `parseEndpoint()` and the Go `minio-go` client in `workers/internal/storage/storage.go`]` |
| `orchestrator` | `RENDER_SERVER_URL` | `http://${{renderserver.RAILWAY_PRIVATE_DOMAIN}}:8090` |
| `orchestrator` | `CORS_ORIGIN` | `web`'s public domain, set **after** `web`'s domain is generated (resolves `D-42`) |
| `orchestrator` | `PORT` | Railway-injected, already respected by `main.ts` |
| `renderserver` | `RENDER_SERVER_ADDR` | `:8090` (fixed — private network only, no need to bind Railway's dynamic `$PORT`) |
| `worker` | `WORKER_STORAGE_DIR` | Left at image default (`/data/worker-output`, staging only — not durable, per resolved `D-11`) |
| `web` | `NEXT_PUBLIC_ORCHESTRATOR_URL` | `orchestrator`'s public domain (`https://...`) — **must be set before `web`'s first build**, since `NEXT_PUBLIC_*` is inlined at Next.js build time, not read at runtime |

Order of operations follows from that last constraint: create+deploy `orchestrator` and
generate its public domain first → set `NEXT_PUBLIC_ORCHESTRATOR_URL` on `web` → build/deploy
`web` → generate `web`'s public domain → set `CORS_ORIGIN` on `orchestrator` → restart
`orchestrator` (env change, no rebuild needed since Nest reads it at boot, not build time).

### File changes

1. **`workers/Dockerfile.renderserver`** (new) — mirrors `workers/Dockerfile`'s structure
   (same builder base, same `libvips-dev`/`internal/govips-fork` handling, same runtime
   base with `libvips42`/`ffmpeg`), but builds `./cmd/renderserver` and sets
   `ENTRYPOINT ["renderserver"]` instead of `worker`. Resolves `D-38`'s "no Docker/CI
   wiring" half (the auth/object-storage half of `D-38` stays open, unrelated to
   deployment).
2. **`docs/90-deferred-register.md`** (edit) — move `D-16` to Resolved (registry/deploy
   target chosen: Railway, Railpack + Dockerfile builds, no separate container registry
   needed since Railway builds and hosts images itself); resolve `D-41` (single public
   Railway Bucket endpoint used by all three consumers, no public/private split needed);
   resolve `D-42`'s deployment half (`CORS_ORIGIN` now set to the real `web` origin);
   resolve `D-38`'s Docker-wiring half. Add one new entry: NATS runs with no auth in
   `production` (matches local dev), mitigated only by having no public domain / no TCP
   proxy on the `nats` service — deliberate debt, re-evaluate if a second Railway
   environment or service ever needs to be denied access to the same private network.
3. **`CLAUDE.md`** (edit) — Objects row of the stack table gets a one-line footnote: local
   dev uses self-hosted MinIO (`infra/docker-compose.yml`, unchanged), production uses a
   managed Railway Bucket — both are plain S3-compatible endpoints behind the same
   `MINIO_*` env vars, so this is a deploy-target choice, not a code or contract change.
4. **`README.md`** (edit) — add a Deployment section: Railway topology (the 6-service
   table above), env var wiring summary, link to this task doc. Grep `README.md` and
   `apps/*/README.md` for stale `localhost`-only deploy claims per §3.2.

No other application code changes are anticipated — `main.ts`, `db.service.ts`,
`nats.service.ts`, `upload.service.ts`, `batch.ts`, and `export.ts` are already
env-var-driven and deploy-target-agnostic (see Cenário actual). If the `[VERIFY]` items
above turn up a real incompatibility (bucket `urlStyle`, NATS image entrypoint), this doc
gets updated with the fix before it's considered done, per §1.2.

## Porquê

**Railway over Vercel, and not split across both.** This stack is polyglot with real
stateful infra (Postgres, NATS JetStream, MinIO/S3, a Go worker pool that must run as
long-lived replicas) — `infra/docker-compose.yml` already models it as a set of
long-running containers. Railway runs arbitrary Dockerized services with persistent
volumes and private networking, which maps close to 1:1 onto that compose file. Vercel's
serverless/edge model doesn't hold a persistent NATS JetStream broker or long-running Go
worker replicas well. Splitting the frontend onto Vercel and everything else onto Railway
was considered and rejected for now: `D-42` already shows a live, unresolved CORS gap and
`D-4` (auth) is still an open spec question — adding a second platform boundary now is
extra complexity (cross-origin cookies/auth once `D-4` resolves, two dashboards, two
deploy pipelines) for marginal DX benefit at this stage. Single-platform keeps the
deploy story simple; `apps/web` can move to Vercel later without touching the backend.

**Railway Bucket over self-hosted MinIO**, decided explicitly with the user rather than
silently, because it isn't just an ops preference — it resolves `D-41` for free. `D-41`
already predicted that containerizing this stack "for real" would force a public/internal
endpoint split, because presigned upload/download URLs are generated server-side
(`upload.service.ts`) but used directly by the browser (`batch.ts`, `export.ts`): the
signing host and the host the browser actually hits must be the same reachable endpoint.
A self-hosted MinIO container on Railway would need its own public domain, TLS, and a
volume to manage just to make that true. Railway's Bucket is S3-compatible with a public
endpoint by default, so one endpoint serves the orchestrator's signing calls, the Go
worker's direct calls, and the browser's presigned PUT/GET — no split, no MinIO volume to
operate, and zero application code changes, since the app already talks to any
S3-compatible endpoint through generic `MINIO_*` env vars (`minio` npm client,
`minio-go/v7` on the Go side) rather than anything MinIO-specific. Local dev keeps
self-hosted MinIO (`infra/docker-compose.yml` untouched) — this only changes what backs
the *production* endpoint.

**A new Dockerfile for `renderserver` instead of extending `workers/Dockerfile` with a
build arg.** `D-38` already flagged this gap. `renderserver` and `worker` share the same
runtime dependencies (`libvips42`, `ffmpeg`, the `govips` fork) but are separate binaries
serving separate roles (async NATS-dispatched batch processing vs. synchronous
single-image editor export) — a second small Dockerfile is more legible than parametrizing
one Dockerfile with a build arg for which `cmd/` package to build, and matches how the
two binaries are already separate `go build` targets in CI (`ci.yml`).

**Shared-monorepo Railway pattern (no `rootDirectory`) for `orchestrator` and `web`.**
Both import `@plexus/recipe` via `workspace:*`. Setting `rootDirectory` to `apps/orchestrator`
or `apps/web` would hide that workspace package from the build, per the Railway skill's
own documented pitfall ("Using `rootDirectory` with shared imports"). Scoping the build
and start commands with `pnpm --filter <name>` from the repo root avoids that without
needing a Dockerfile for either TypeScript service.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `workers/Dockerfile.renderserver` | new | Mirrors `workers/Dockerfile`, builds `./cmd/renderserver` |
| `docs/90-deferred-register.md` | edit | Resolve `D-16`, `D-41`, `D-42` (deploy half), `D-38` (Docker-wiring half); add new NATS-no-auth-in-prod entry |
| `CLAUDE.md` | edit | Objects stack-table row: footnote distinguishing dev (self-hosted MinIO) vs prod (Railway Bucket) |
| `README.md` | edit | New Deployment section: Railway topology, env var wiring, link to this doc |

Railway-side provisioning (project, 6 services, 1 volume, 1 bucket, env vars, 2 public
domains) happens via the `railway` CLI/MCP per the table above — not a file change, but
tracked here since it's the bulk of this task's actual work.
