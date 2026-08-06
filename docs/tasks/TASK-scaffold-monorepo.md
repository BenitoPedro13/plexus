# TASK-scaffold-monorepo

## Cenário actual

The Plexus repository currently contains only documentation: `CLAUDE.md` (workflow
rules) and `docs/plexus-media-pipeline-spec.md` (the product/architecture spec). There is
no git repository (`git status` fails with "not a git repository"), no `package.json`, no
`go.mod`, no CI, no local infra, and no code of any kind. `docs/90-deferred-register.md`
does not exist yet either, even though the spec's Open Questions section is meant to seed
it (CLAUDE.md §0, §3.1).

Per CLAUDE.md §1, the initial repo scaffold requires a task document before any file is
created — this is that document, covering the **first commit** of the project: version
control, the polyglot monorepo skeleton, and just enough of it to start Phase 1 ("Core
pipeline engine": Orchestrator + single Go worker type + Postgres + NATS, linear pipelines
only, per spec §"Suggested Phasing").

## Mudanças planeadas

**Scope decision:** scaffold the repo-level skeleton and tooling decisions now, but only
run app-generators for the pieces Phase 1 actually needs (`apps/orchestrator`, `workers/`).
`apps/web` (Next.js editor), `proto/` (gRPC contract), and `packages/` (shared TS types)
are Phase 2/3/4 concerns per the spec's phasing — scaffolding them now would mean
generating boilerplate against framework versions that may have moved on by the time those
phases start, which cuts against CLAUDE.md §2.0. Each gets created in its own phase's task
doc instead. This is recorded as decision D-1 in the deferred register (planned below).

**Tooling versions used below were verified via web search on 2026-08-06 (CLAUDE.md
§2.0) — not from training memory:**

| Tool | Version | Source |
|---|---|---|
| Node.js package manager | **pnpm 11.14** (stable; 12.0.0-beta.3 exists but is pre-release) | pnpm.io/blog |
| Next.js | 16.2.x (Active LTS) — not scaffolded this task, noted for Phase 2 | nextjs.org/support-policy |
| NestJS | **11.1.x** (stable). v12 (ESM, Vitest, Rspack) targeted ~Q3 2026, not yet released — do not scaffold against it | nestjs.com roadmap coverage |
| Go | **1.26.5** (latest stable) | go.dev/doc/go1.26 |
| PostgreSQL | **18.4** (stable). v19 is Beta 1 only — not production-ready, do not use | postgresql.org release notes |
| NATS Go client | `github.com/nats-io/nats.go` **v1.52.0**, using the `jetstream` subpackage (the modern JetStream API, not the legacy `nats.JetStream()` calls) | github.com/nats-io/nats.go |

### 1. Version control

- `git init` at repo root.
- `.gitignore` (new) — Node (`node_modules`, `.next`, `dist`), Go (`bin/`, compiled
  binaries), env files (`.env`, `.env.local`), OS cruft (`.DS_Store`).
- First commit after scaffold is reviewed and files are in place (not part of this
  automated pass — left for explicit user confirmation before pushing anywhere).

### 2. Repo root — TypeScript workspace tooling

- **Package manager decision: pnpm.** Chosen because CLAUDE.md's own examples
  standardize on it (`pnpm create next-app@latest` appears repeatedly in §2.0/§2.1), it has
  first-class workspace support for the `apps/*` + `packages/*` layout in CLAUDE.md §4,
  and it's the primary alternative the spec's stack table implies over npm/yarn. Recorded
  as the scaffold-time decision required by §4 ("one package manager, chosen at scaffold
  time and never mixed").
- `package.json` (new) — root workspace manifest, `"private": true`, `packageManager`
  field pinned to `pnpm@11.14.x` (via `corepack`), no build scripts yet (nothing to build
  until `apps/orchestrator` exists).
- `pnpm-workspace.yaml` (new) — declares `apps/*` and `packages/*` as workspace roots so
  future `apps/web` / `packages/*` additions need no repo-root reconfiguration.
- `.nvmrc` or `engines` field (new) — pin Node major to whatever `pnpm@11.14` currently
  recommends as its minimum supported Node — `[VERIFY: pnpm 11.14's minimum supported
  Node major, check pnpm.io/installation before pinning]`.

### 3. `apps/orchestrator/` (new) — NestJS, scaffolded via CLI

- Run `nest new orchestrator --package-manager pnpm` (or the current-equivalent flag —
  verify against `nest new --help` at execution time, not from memory) inside `apps/`,
  targeting NestJS 11.1.x (current stable, installed by the CLI's own default — do **not**
  pin to v12 pre-release).
- No hand-written NestJS boilerplate — everything the CLI generates (module, controller,
  service stubs, `nest-cli.json`, `tsconfig.json`) is kept as-is; Phase 1 work adds
  modules on top of this in a separate task doc (`TASK-job-state-machine.md` or similar),
  not this one.
- This scaffold task does **not** wire up Postgres/NATS clients inside the orchestrator —
  that's Phase 1 implementation, not scaffold. This task only proves `pnpm --filter
  orchestrator start:dev` boots a bare NestJS app.

### 4. `workers/` (new) — Go module, single worker type per Phase 1

- `go mod init github.com/<org-or-user>/plexus/workers` (module path needs a real
  GitHub owner/repo — `[VERIFY: confirm intended GitHub org/user before running, since the
  module path is awkward to rename later]`).
- `go.mod` targets Go 1.26.
- Minimal directory skeleton: `workers/cmd/worker/main.go` (entrypoint, currently just
  boots and logs "worker started" — no processor logic yet, that's Phase 1
  implementation), `workers/go.mod`, `workers/go.sum`.
- `golangci-lint` config (`.golangci.yml`, new) added now per CLAUDE.md §4 ("`go
  vet`/`golangci-lint` from day one") even though there's barely any Go code yet — cheap to
  add at scaffold time, expensive to retrofit once lint debt accumulates.
- No ffmpeg/libvips bindings or NATS/Postgres client wiring yet — that's Phase 1
  implementation (processors: resize, convert, compress), tracked in a follow-up task doc.

### 5. Local infra — `infra/docker-compose.yml` (new)

- Postgres 18.4 and NATS (with JetStream enabled, `-js` flag) as local dev dependencies —
  Phase 1 cannot be developed or tested without both running somewhere, and testcontainers
  (used in actual tests per CLAUDE.md §0 Tests) spin up their own instances per test run,
  but developers still need a persistent local instance to run the orchestrator/worker by
  hand during development.
- Hand-written compose file (no generator fits this) using the official `postgres:18` and
  `nats:latest` (with JetStream flag) Docker images — matches CLAUDE.md §2.2's exception
  for cases with no applicable generator.
- `.env.example` (new, repo root) — `DATABASE_URL`, `NATS_URL` matching the compose
  file's exposed ports. Kept in sync with actual env var usage once orchestrator/worker
  code reads them (CLAUDE.md §3.1).

### 6. `docs/90-deferred-register.md` (new)

Created in this same pass since this task is the first one that postpones anything
(CLAUDE.md §0, §3.1: "create it in the same pass that first postpones something"). Seeded
from:
- The spec's existing Open Questions section (object storage self-hosted vs. managed,
  auth approach, WebGPU fallback fidelity, composite-slider parameter mapping, plugin
  sandboxing tier) as `V-xx`/`D-xx` entries, cross-referenced back to the spec section.
- New entries surfaced by this task itself:
  - **D-1**: `apps/web`, `proto/`, `packages/` deliberately not scaffolded yet — deferred
    to Phase 2 (editor) / Phase 4 (plugins) task docs, re-evaluation trigger: "start of the
    task doc for that phase."
  - **D-2**: Go module path uses a placeholder org/user pending `[VERIFY: confirm GitHub
    owner]` above — re-evaluation trigger: "before first `go get` of an external dependency
    that would embed the wrong import path in its go.sum."
  - **V-1**: pnpm's minimum Node major for v11.14 — `[VERIFY: ...]` above — re-evaluation
    trigger: "before pinning `.nvmrc`."

### 7. `CLAUDE.md` update

- §4 currently says the repo layout is "the working proposal... not yet scaffolded."
  Once this task executes, update that sentence to reflect that `apps/orchestrator` and
  `workers/` exist, while `apps/web`/`proto/`/`packages/` remain proposed-but-deferred
  (cross-reference D-1).

## Porquê

This is the first commit of the project — everything downstream (Phase 1's job state
machine, Phase 2's editor, every later task doc) assumes a working monorepo skeleton,
a chosen package manager, and running local Postgres/NATS. CLAUDE.md §1 requires this
exact task-doc-first treatment even for the initial scaffold, specifically so tooling and
layout decisions (package manager, what gets scaffolded now vs. later) are made visibly and
can be pushed back on before any generator runs, rather than being silently baked into the
first commit.

Scoping this task to only `apps/orchestrator` + `workers/` (not the full proposed layout)
follows the top-level instruction against building ahead of what's needed: Phase 1 per the
spec's own phasing doesn't touch the editor, plugins, or shared packages, so generating
Next.js/proto boilerplate now would be dead weight sitting untouched until Phase 2+, and
risks drifting from "current stable" (CLAUDE.md §2.0) by the time it's actually used.

Verifying every tool version via web search (rather than from training data) directly
follows CLAUDE.md §2.0 — framework tooling moves faster than model training cutoffs, and
this stack has five independent fast-moving toolchains (Next.js, NestJS, Go, Postgres,
NATS) where a stale assumption would show up as a broken `nest new` flag or an
already-superseded Postgres major.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `.git/` | new | `git init` |
| `.gitignore` | new | Node + Go + env + OS ignores |
| `package.json` | new | root workspace manifest, pnpm-pinned |
| `pnpm-workspace.yaml` | new | declares `apps/*`, `packages/*` |
| `.nvmrc` | new | Node version pin, pending `[VERIFY: ...]` |
| `apps/orchestrator/**` | new | generated by `nest new`, NestJS 11.1.x |
| `workers/go.mod`, `workers/go.sum` | new | Go 1.26 module |
| `workers/cmd/worker/main.go` | new | bare entrypoint, no processor logic yet |
| `.golangci.yml` | new | lint config for `workers/` |
| `infra/docker-compose.yml` | new | Postgres 18.4 + NATS JetStream, local dev only |
| `.env.example` | new | `DATABASE_URL`, `NATS_URL` |
| `docs/90-deferred-register.md` | new | seeded from spec Open Questions + D-1, D-2, V-1 |
| `CLAUDE.md` | edit | §4 layout note updated to reflect what's actually scaffolded |
| `docs/tasks/TASK-scaffold-monorepo.md` | new | this document |
