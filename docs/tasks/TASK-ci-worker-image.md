# TASK-ci-worker-image — CI workflow + worker Dockerfile (Phase 1, slice 5)

## Cenário actual

No `.github/` directory exists anywhere in the repo, and `workers/` has no `Dockerfile`.
Every check that currently "passes" (`go build`/`go vet`/`golangci-lint`/`go test ./...` for
`workers/`, `tsc`/`eslint`/`jest` for `apps/orchestrator`) has only ever been run locally by
hand, reported in each task doc's own summary — nothing enforces it on push or PR, and there
is no way to build a deployable worker image.

`workers/README.md` documents libvips 8.14+ and ffmpeg as local prerequisites (Homebrew
instructions only) and explicitly flags the gap: "No CI workflow or worker `Dockerfile`
exists yet (`D-12`...) — whichever task adds either must install libvips there too."
`docs/90-deferred-register.md`'s `D-12` entry says the same, extended by
`TASK-video-audio-processors.md` to cover ffmpeg as a second uninstalled-in-CI prerequisite.
This is that task, for both halves: CI workflow *and* worker Dockerfile, since they need the
same two system packages and doing them together avoids verifying libvips/ffmpeg
availability twice.

Both test suites already require Docker (testcontainers — real NATS for the worker, real
NATS+Postgres for the orchestrator, per `CLAUDE.md`'s no-mocking rule), so CI must run
somewhere Docker is available.

## Mudanças planeadas

### `.github/workflows/ci.yml` (new)

Triggers: `push` to `main` and `pull_request` (any branch). Two independent jobs, both on
`ubuntu-latest` (confirmed via `actions/runner-images`'s own Ubuntu 24.04 readme that Docker
Server is preinstalled — required for both sides' testcontainers suites, no `docker:dind`
service needed).

- **`orchestrator`**:
  1. `actions/checkout@v7`
  2. `pnpm/action-setup@v6` (reads the `packageManager` field in root `package.json`, pinned
     `pnpm@11.5.2` — no separate version input needed)
  3. `actions/setup-node@v7` with `node-version-file: .nvmrc` (Node 24) and
     `cache: pnpm`
  4. `pnpm install --frozen-lockfile`
  5. `pnpm --filter orchestrator lint`
  6. `pnpm --filter orchestrator build`
  7. `pnpm --filter orchestrator test` (Jest integration suite — pulls Postgres/NATS
     testcontainer images at run time, no docker-compose needed)

- **`workers`**:
  1. `actions/checkout@v7`
  2. `apt-get update && apt-get install -y --no-install-recommends libvips-dev ffmpeg
     pkg-config` — versions confirmed available on the `ubuntu-24.04` apt repos actually used
     by GitHub-hosted `ubuntu-latest` runners (not assumed): `libvips-dev` 8.15.1-1.1build4
     (`>= 8.14` required by `workers/README.md`), `ffmpeg` 7:6.1.1-3ubuntu5, `pkg-config`
     1.8.1-2build1 — checked by running `apt-cache policy` inside an `ubuntu:24.04` container
     for this task, not from memory (CLAUDE.md §2.0). No `CGO_CFLAGS_ALLOW` workaround needed
     — that's specific to Homebrew's vips headers on macOS, not the apt package.
  3. `actions/setup-go@v7` with `go-version-file: workers/go.mod` (resolves `1.26.5`)
  4. `go vet ./...` (`working-directory: workers`)
  5. `golangci-lint/golangci-lint-action@v9` with `working-directory: workers` — action
     auto-resolves a `golangci-lint` binary compatible with the repo's existing
     `.golangci.yml` (`version: "2"` schema; latest release confirmed `v2.12.2`, same major)
  6. `go test ./...` (`working-directory: workers`) — pulls the NATS testcontainer image at
     run time

No path filtering (`paths:`) on either job — repo is small enough that running both on every
push is simpler than maintaining a filter list, and a shared file (e.g. this task doc itself,
or a future `proto/` change) could affect either side.

### `workers/Dockerfile` (new)

Multi-stage build, versions confirmed by pulling and inspecting the actual images for this
task (not assumed):

- **Builder**: `golang:1.26.5-bookworm` — exact patch-version tag exists on Docker Hub,
  matches `workers/go.mod`'s `go 1.26.5` precisely. Confirmed `gcc`, `cc`, and `pkg-config`
  are already present in this image (checked via `docker run ... which gcc cc pkg-config`) —
  only `libvips-dev` needs installing via apt, same 8.14.1-3+deb12u3 package confirmed
  available on `debian:bookworm` (builder's own base). `COPY go.mod go.sum` +
  `go mod download` before `COPY . .` for layer caching, then
  `CGO_ENABLED=1 go build -o /out/worker ./cmd/worker`.
- **Runtime**: `debian:bookworm-slim` (matches builder's glibc/ABI — govips's cgo bindings
  link against libvips's shared library, so runtime and build-time libvips must be
  ABI-compatible; using the same Debian release for both is the safe default rather than
  switching to Alpine/musl). Installs `libvips42` (runtime shared lib, confirmed as the
  correct non-`-dev` package name via `apt-cache search libvips` on `debian:bookworm-slim`),
  `ffmpeg` (5.1.9, confirmed available same as the builder base), and `ca-certificates`
  (outbound TLS — NATS/future MinIO connections). Runs as a non-root `worker` user.
  `ENV WORKER_STORAGE_DIR=/data/worker-output`, directory created and chowned to that user in
  the image. `ENTRYPOINT ["worker"]`.
- Not building/pushing the image anywhere yet — no registry, no `docker build` step added to
  `ci.yml` in this task. That's Phase 1's deployment story, not scoped here; tracked as a new
  `D-xx` (below) rather than silently expanded into this task.

### `workers/README.md` (edit)

Remove the two "No CI workflow or worker `Dockerfile` exists yet" callouts (libvips section
and ffmpeg section) now that both exist; add a one-line pointer to `.github/workflows/ci.yml`
and `workers/Dockerfile` instead so the prerequisites section doesn't go stale again.

### `docs/90-deferred-register.md` (edit)

- Move `D-12` to **Resolved**, dated today, referencing this task doc.
- Add a new `D-xx`: worker Docker image is built (`workers/Dockerfile`) but not pushed to any
  registry or wired into a deploy pipeline — no `docker build`/`push` step in `ci.yml`, no
  registry chosen. Re-evaluation trigger: whenever Phase 1 moves from "runs locally" to
  "deployed somewhere," which needs a registry decision first (another Open Question-shaped
  gap, not silently resolved here).

## Porquê

`D-12` has been sitting in the deferred register since slice 3 and was flagged again at the
end of slice 4 as the natural next task — every processor the worker can run today
(`image.*`, `video.*`, `audio.*`) has only ever been verified by a human running `go test`
locally with Homebrew-installed libvips/ffmpeg. Nothing currently stops a change that breaks
on Linux (glibc vs. Homebrew's macOS build, a Linux-only ffmpeg encoder gap, etc.) from
merging unnoticed. CI is the mechanism that actually enforces every "clean" claim in past task
docs' summaries going forward, and per CLAUDE.md §0 ("Tests are a first-class requirement")
and §3 (docs must not silently drift), leaving it unenforced any longer than necessary works
against both.

The Dockerfile is bundled into the same task rather than split out because it needs the exact
same two system-package verifications (libvips version floor, ffmpeg presence) that the CI
job needs — verifying them once, in one task doc, for both consumers avoids the risk of the
two drifting (e.g. CI apt-get pinning one libvips version, the image another).

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `.github/workflows/ci.yml` | new | Two jobs: `orchestrator` (pnpm/Node, lint+build+test) and `workers` (apt libvips-dev/ffmpeg/pkg-config, go vet/golangci-lint/test) |
| `workers/Dockerfile` | new | Multi-stage: `golang:1.26.5-bookworm` builder (+libvips-dev) → `debian:bookworm-slim` runtime (+libvips42, ffmpeg, ca-certificates), non-root user |
| `workers/.dockerignore` | new | Excludes `testdata/`, `data/`, `*.md`, `.git` from the build context |
| `workers/README.md` | edit | Remove the two stale "no CI/Dockerfile yet" callouts; point at the new files instead |
| `docs/90-deferred-register.md` | edit | Resolve `D-12`; add new `D-xx` for "image not pushed/deployed anywhere yet" |
