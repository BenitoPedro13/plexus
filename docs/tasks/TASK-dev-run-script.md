# TASK: One-command local dev — `pnpm dev`

## Cenário actual

Running Plexus locally today needs four separate terminals, by hand, in a specific order,
each with its own gotchas discovered live during `TASK-apply-to-batch.md`'s browser
verification (`docs/90-deferred-register.md` `D-43`, `D-44`):

1. `docker compose -f infra/docker-compose.yml up -d` — no `--wait`, so a caller has no
   signal for when Postgres/NATS/MinIO are actually healthy, only that the containers
   started.
2. `pnpm --filter orchestrator start:dev` (or `cd apps/orchestrator && pnpm start:dev`) —
   crashes immediately with `S3Error: Valid and authorized credentials required` unless the
   repo-root `.env` has already been manually exported into the shell first
   (`set -a; source .env; set +a`). Nothing in `apps/orchestrator/src/main.ts` loads `.env`
   — no `dotenv`/`@nestjs/config` import anywhere (`D-43`). **Also** — until just fixed in
   this task's own first commit-adjacent change — `DbService`
   (`apps/orchestrator/src/db/db.service.ts`) never ran migrations on startup (only
   `test/support/postgres-test-db.ts` did), so a fresh `docker compose` Postgres volume had
   no tables at all: the user's first real `POST /pipelines` failed with `relation
   "pipelines" does not exist` (`D-44`, now resolved — `DbService` gained an `OnModuleInit`
   that calls `migrate()`).
3. `cd workers && go run ./cmd/worker` — same `.env`-not-loaded crash (`connect to object
   storage: MINIO_ENDPOINT is not set`), no Go-side `.env` loader exists at all.
4. `cd apps/web && pnpm dev` — defaults to port 3000, colliding with the orchestrator's own
   default `PORT=3000`; the root README's current workaround is "adjust the orchestrator's
   PORT if both would collide," i.e. manually picking non-conflicting ports each time.

None of this is wired together, and there is no single command that brings up a working
local environment. The user explicitly asked for one, and chose the "root pnpm script +
`concurrently`" approach (over a `Procfile`/`overmind` or adopting Turborepo) when offered
the choice.

## Mudanças planeadas

- **`package.json` (root)** — add `concurrently` and `dotenv-cli` as root `devDependencies`
  (both plain, widely-used CLIs — no generator scaffolds a cross-language dev-orchestration
  script, so hand-writing the wiring itself is the correct fallback per CLAUDE.md §2.2; the
  *loading* of `.env` still goes through `dotenv-cli`'s own CLI rather than hand-rolled
  parsing). New `"dev"` script: loads the repo-root `.env` via `dotenv -e .env --`, brings
  infra up and waits for health (`docker compose -f infra/docker-compose.yml up --wait`),
  then fans out to the three long-running dev processes via `concurrently` — orchestrator
  (`pnpm --filter orchestrator start:dev`), the Go worker (`go run ./cmd/worker` from
  `workers/`), and the web app (`pnpm --filter web dev -- -p 3001`, the port bump avoiding
  the orchestrator's `PORT=3000`). All three inherit the exported `.env` vars from the
  parent shell — no per-app loader needed for this path (`D-43`'s fix is *at the
  orchestration layer*, not inside `main.ts`/`main.go`; running an app standalone, outside
  `pnpm dev`, still needs the manual export, which stays documented).
- **`apps/web/package.json`** — no change needed: the port is passed at invocation time
  (`next dev -- -p 3001`) from the root script, not hardcoded into the app's own `dev`
  script, so `cd apps/web && pnpm dev` unchanged still defaults to 3000 for anyone running
  it standalone.
- **`README.md` (root)** — replace the four-terminal "Getting started" block with `pnpm dev`
  as the primary path; keep the per-terminal manual steps underneath as "running pieces
  individually" for anyone debugging one process in isolation, now explicitly noting the
  `set -a; source .env; set +a` requirement for that path.
- **`docs/90-deferred-register.md`** — resolve `D-43` (env-loading gap): the primary
  supported path (`pnpm dev`) no longer needs it; the narrower "each app also loads `.env`
  standalone" enhancement stays explicitly out of scope, noted as accepted status quo, not
  re-opened as a new item.

## Porquê

The four-terminal manual dance was never designed, it accreted — each piece was built and
verified independently (orchestrator via `nest start:dev` in its own README, the worker via
`go run` in `workers/README.md`, web via `next dev`) with nobody needing to run all three
plus infra together until `TASK-apply-to-batch.md`'s browser flow made that the only way to
actually see the feature work end-to-end. Fixing it at the orchestration layer (one root
script) rather than inside every app's own bootstrap (`dotenv/config` in `main.ts`, a Go
`.env` loader in `main.go`) is deliberately the smaller change: it solves the *stated* DX
problem (one command) without adding a new runtime dependency to two separate language
runtimes for a dev-only concern, and it composes with `concurrently`'s own labeled/colored
output for free instead of interleaving three processes' raw stdout by hand.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `package.json` (root) | edit | add `concurrently`, `dotenv-cli` devDeps; new `"dev"` script |
| `README.md` (root) | edit | `pnpm dev` as the primary Getting Started path |
| `docs/90-deferred-register.md` | edit | resolve `D-43` |
| `apps/orchestrator/src/db/db.service.ts` | edit | `OnModuleInit` runs `migrate()` — already applied, resolves `D-44` |
| `apps/orchestrator/README.md` | edit | already updated by `TASK-apply-to-batch.md`'s pass; no further change expected here |
| `scripts/dev.sh` | new | not itemized above; holds the actual orchestration logic so `package.json`'s script stays a one-liner |

## Implementação — decisions made that weren't fully pinned above

- **`scripts/dev.sh`, not an inline `package.json` one-liner.** Nesting `concurrently`'s own
  quoted sub-commands inside `dotenv -e .env -- bash -c "..."` inside a JSON string is an
  escaping mess; a small `set -euo pipefail` shell script is more readable and diffable.
  `package.json`'s `"dev"` script is just `dotenv -e .env -- bash scripts/dev.sh`.
- **`docker compose up --wait` runs synchronously *before* `concurrently` starts**, not as a
  fourth parallel command — `concurrently` has no built-in "run this first, then these in
  parallel" dependency ordering (confirmed against its current README), and the three dev
  processes all assume a reachable, healthy Postgres/NATS/MinIO from their first request
  (`DbService`'s constructor connects immediately; `UploadService.onModuleInit` calls
  `bucketExists`). Sequencing this in the shell script avoids inventing a wait-for-health
  polling loop `docker compose --wait` already does correctly.
- **`--kill-others`** (concurrently flag, confirmed via `--help` against the installed
  version) — if the orchestrator crashes, the worker/web dev servers are not useful running
  alone, so tearing down the whole group on any one exit gives one clear failure instead of
  two dev servers quietly still up against a dead backend.
- **Web's port bump (3001) is passed at invocation** (`pnpm --filter web dev -- -p 3001`),
  not hardcoded into `apps/web/package.json`'s own `"dev"` script — so `cd apps/web && pnpm
  dev` standalone is unchanged (still defaults to 3000), only the root-orchestrated path
  picks a non-colliding port.
- **`concurrently`/`dotenv-cli` added as root `devDependencies`** (`pnpm add -D -w`), not
  duplicated into `apps/web`/`apps/orchestrator` — this is a repo-wide dev-orchestration
  concern, not owned by any one workspace package.
- **Verified**: `bash -n scripts/dev.sh` (syntax), `docker compose -f infra/docker-compose.yml
  up --wait` run directly (confirmed all three services report Healthy), `pnpm exec
  concurrently --help` confirmed `-n`/`-c`/`-k` against the actually-installed version
  rather than assumed from memory (CLAUDE.md §2.0). **Not run end-to-end as `pnpm dev`**
  in this session — the user already had a manual orchestrator/worker/web session live on
  the same ports during implementation; starting a second copy would have port-conflicted
  with their in-progress testing rather than proven anything new. Owed: the user (or a
  future session) running `pnpm dev` from a clean slate.
