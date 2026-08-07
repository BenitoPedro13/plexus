# Workflow Guidelines — Plexus (Extensible Media Processing Pipeline)

> This file follows a portable process template (plan before you touch anything, lean on
> existing tooling while you work, treat documentation as part of the deliverable when you
> finish) instantiated for this specific project. Section 0 is Plexus-specific; sections
> 1–4 are the portable rules with paths and examples adapted to this repo.
>
> The philosophy in one line: **Plan before you write, lean on existing tooling while you
> work, and treat documentation as part of the deliverable when you finish.**

---

## 0. Project context — Plexus (Extensible Media Processing Pipeline)

**Specification-stage project. No code exists yet.** The entire spec lives in
`docs/plexus-media-pipeline-spec.md`. Working title: **Plexus** ("plexus" = a network of
interconnected nodes — fits a DAG of pluggable processors).

A general-purpose, extensible media processing engine — a mini Cloudinary /
Zapier-for-media: users upload files, run declarative multi-step pipelines (DAGs of
processors like `resize → watermark → compress → convert`), watch progress in real time,
and extend the system with plugins in any language. On top of it sits an equally
first-class **image editor that must feel like Apple Photos** — non-destructive,
recipe-based, live client-side preview via WebGPU, curated composite controls — with none
of the pipeline/DAG machinery visible to the person dragging a slider.

**The unifying idea:** an **Edit Recipe** (ordered list of `{ processor, params }`) is
*structurally identical* to a pipeline definition. "Edit one image by hand" and "define a
batch pipeline" are the same data structure viewed through two UIs. This is what makes
"edit once, apply to 500 files" nearly free architecturally.

**Not building in v1** (spec Non-Goals — arguments, not throwaway remarks): timeline-based
video editing, multi-tenant billing/SaaS metering, mobile apps, a visual drag-and-drop DAG
builder, professional RAW development, and any editor UI that exposes pipeline concepts
(jobs, queues, processor names) — if a user needs to know what a "processor" is to use the
editor, that goal has failed.

### Start here

1. `docs/plexus-media-pipeline-spec.md` — the full spec: problem statement, goals,
   architecture, P0/P1/P2 requirements, success metrics, open questions, phasing.
2. Its **Open Questions** section — decisions still unmade (auth approach, WebGPU fallback
   fidelity, plugin sandboxing tier — object storage and composite-slider → parameter
   mapping are resolved, see the section itself for current status). Do not silently
   resolve one of these in code; see §1 and §3.
3. `docs/90-deferred-register.md` — **living document, create it in the same pass that
   first postpones something.** Everything deferred, unverified, or deliberately debt-shaped
   lives there once implementation starts.

**Status:** spec drafted. Next step is Phase 1 of the spec's phasing: core pipeline engine
(orchestrator + one Go worker type + Postgres + NATS, linear pipelines, built-in
resize/convert/compress processors). Each phase is independently demoable; Phase 2 (editor
MVP) is a shippable milestone on its own.

### Stack (per spec — see "Go vs TypeScript Split" and "Architecture Overview")

| Layer | Choice |
|---|---|
| Frontend | **Next.js** (TypeScript) — upload, dashboard, live progress; **always the latest stable major**, never a pinned number (see §2.0) |
| Editor live preview | TypeScript + **WebGPU** in-browser render of original-plus-recipe — no server round-trip per adjustment; feature-detect `navigator.gpu` with a reduced-fidelity Canvas2D/WebGL fallback |
| Orchestrator | **NestJS** (TypeScript) — auth, pipeline DAG resolution, job state machine |
| Worker pool | **Go** — CPU-bound built-in processors (ffmpeg, libvips, compression); horizontally scalable replicas |
| Final export / batch render | Go — the same recipe executed server-side at full resolution; one execution engine backs both preview (approximately) and output (exactly) |
| Plugin contract | **gRPC (protobuf)** — `Process(input) -> output`, language-agnostic, registered at runtime |
| Queue + event bus | **NATS JetStream** — persistent, replayable; one piece of infra for both job dispatch and the realtime progress stream (deliberately not RabbitMQ) |
| Data | **PostgreSQL** via **Drizzle ORM** (`drizzle-orm/node-postgres`) — jobs, pipelines, recipes, plugin registry. Chosen over Prisma specifically because Prisma still has no native PostGIS geometry/geography support (`TASK-job-state-machine.md`); SQL-first Drizzle doesn't block a future Places/map view built on photo GPS EXIF data |
| Objects | **MinIO** (self-hosted, resolved — see `docs/90-deferred-register.md` D-3) — presigned-URL upload/download via each side's own MinIO SDK (`minio-go/v7` in `workers/internal/storage`, the `minio` npm client in `apps/orchestrator/src/upload`), never proxy large files through the API |
| Realtime | SSE/WebSocket fan-out to the frontend, driven off the same NATS event stream used for dispatch |

The Go/TypeScript split is architecturally load-bearing, not decorative: TypeScript where
work is I/O-bound and iteration speed wins (frontend, orchestrator), Go where work is
CPU-bound and per-worker memory/concurrency matter (processors, export). Do not blur it —
media processing logic does not creep into the orchestrator, and business logic does not
creep into workers.

**Version numbers and browser-support claims written anywhere in this file or the spec are
a snapshot at time of writing, not a pin.** Treat every one as potentially stale — see
§2.0 before scaffolding or adding a dependency.

### How to write in this repo

- **Never invent an API, protocol detail, codec behaviour, or browser capability.** Write
  `[VERIFY: what to check and where]` inline instead, and check the tool's own docs
  (ffmpeg, libvips, NATS, WebGPU) before code relies on it.
- **Nothing is deferred silently.** Every postponement goes in
  `docs/90-deferred-register.md` (create it on first use): `V-xx` unverified claims ranked
  by consequence, `D-xx` deliberate debt with re-evaluation triggers. The spec's Open
  Questions section is the pre-implementation seed of this register.
- **Challenge the premise**, including the spec's. The spec already treats the editor as a
  first-class half of the project rather than a UI afterthought for exactly this reason.
- Be specific to the point of discomfort: named libraries and versions, function
  signatures, numeric thresholds. No acceptance criterion may use "works", "correct",
  "fast" or "feels good" — the spec's success metrics (throughput at N replicas,
  time-to-first-progress-event, preview latency, preview/export drift) set the pattern.
- Prefer boring proven technology. Cut ruthlessly. Separate P0 from P1/P2 (the spec
  already does; keep it that way).

### Tests

Tests are a first-class requirement, not a phase, once implementation starts:

- **Against real infrastructure via testcontainers** — real Postgres, real NATS
  JetStream, real MinIO. **Mocking the database or the queue is banned in the orchestrator's
  domain logic and the Go workers** — that rule demands more real testing, not less.
- **Golden fixtures for processors** — small committed input files, assertions on
  measurable output properties (dimensions, format, size bounds), not byte-equality where
  encoders are non-deterministic.
- **Recipe fidelity is measured, not eyeballed** — drift between the WebGPU/WebGL preview
  approximation and the Go ground-truth render gets a numeric bound per composite control,
  and a test that enforces it.
- The governing worry: a job that silently loses work, or an export that doesn't match the
  preview the user approved.

### Things that must not break

- **Non-destructive editing** — nothing is ever "applied" to pixels until export. Every
  editor control writes recipe parameters; undo/redo is recipe history. No code path may
  mutate stored originals.
- **Recipe/pipeline unification (reuse proof)** — a recipe built by hand on one image runs
  *unmodified* as a batch pipeline across many files. No "convert my edit into a pipeline"
  translation step may ever appear.
- **No lost jobs** — a worker killed mid-job must not lose the job; another replica picks
  it up. Demonstrated explicitly, per the spec's failure-handling metric.

---

## 1. Plan before executing — write a task document first

**Rule:** Before editing or creating **any** code file, always write a task document at
`docs/tasks/TASK-<slug>.md` describing the work. No exceptions for "small" changes — a
change that looks like a one-liner often hides assumptions worth surfacing first.

This applies from the very first scaffold commit: no code exists yet, so the initial repo
scaffold, the first migration, and the first worker each get a task document before any
file is created. Resolving one of the spec's Open Questions in the course of a task is a
decision, not a side effect — record it in the task doc's Why section and update the spec
(§3).

### 1.1 Required sections

Every task document must contain these four sections, in this order:

1. **Current scenario (`Cenário actual`)** — How it works *today*. What exists, what the
   relevant code/flow does right now, and specifically what is broken, blocked, missing, or
   limiting. Be concrete: name the files, functions, endpoints, env vars, or tables
   involved. If there is a bug, describe the exact observed behaviour and (if known) the
   root cause.

2. **Planned changes (`Mudanças planeadas`)** — What will change, **file by file**.
   Describe the new behaviour, not just "edit X". For each file, say what is being added,
   modified, or removed and how the pieces connect. If there are alternatives you
   considered and rejected, note them briefly so the reviewer understands the choice.

3. **Why (`Porquê`)** — Justification with business and/or technical context. Why is this
   the right change? What problem does it solve, what does it unblock, what does it cost?
   This is the section that lets a reviewer agree or push back *before* code exists.

4. **Affected files (`Ficheiros afectados`)** — A table listing every file the change
   touches, with the type of change:

   | File | Change type | Notes |
   |------|-------------|-------|
   | `apps/orchestrator/src/jobs/job.service.ts` | edit | add `retryStep()` method |
   | `proto/plexus/v1/processor.proto` | new | gRPC plugin contract |
   | `apps/orchestrator/src/old.ts` | removal | superseded by `job.service.ts` |

### 1.2 How to apply it

- **Write the document silently.** Do not dump its full contents into the chat. Create the
  file, then point the user at it (or summarize in 2–3 lines) and wait for alignment when
  the change is significant. Only proceed to code after the user has reviewed/approved.
- **One document per task / unit of work.** Use a short, descriptive kebab-case slug:
  `TASK-scaffold-monorepo.md`, `TASK-job-state-machine.md`, `TASK-recipe-schema.md`.
- **Keep it in sync.** If the plan changes mid-task, update the document — it is a living
  record of intent, not a write-once artifact.
- **The document is the contract.** When in doubt about scope, the task doc is the source
  of truth for what was agreed. It does not replace `docs/90-deferred-register.md` — any
  postponement discovered while writing or executing a task doc still goes into the
  register, not just noted in the task doc.

### 1.3 Why this matters

The user wants **review and alignment before code is written**. This avoids doing work that
gets rejected, forces the thinking to happen up front, and leaves a durable trail of *why*
each change was made — useful later when the reasoning behind an architecture decision
(Go/TS boundary, NATS subject layout, recipe schema shape) is no longer obvious.

---

## 2. Use CLIs, generators, and SDKs — don't write everything by hand

**Rule:** Prefer invoking existing, canonical tooling over reimplementing logic or
hand-authoring files that a tool can generate correctly. Reach for the command first; only
hand-write when no tool fits. This matters more than usual here: the stack's whole point is
that heavy media work runs through ffmpeg/libvips (C/C++), never reimplemented in
application code.

### 2.0 Assume your framework knowledge is outdated — check first, every time

**This is of extreme importance, not a nicety.** Frontend and framework tooling moves faster
than any model's training cutoff — and this stack adds fast-moving browser APIs (WebGPU)
and protocol tooling (gRPC/buf, NATS clients) on top. Before scaffolding anything, adding a
dependency, or writing framework-specific code for **any** piece of this stack — Next.js,
NestJS, WebGPU, NATS JetStream clients, gRPC/protobuf toolchains, Go module versions, all
of it — do this, in order:

1. **Go to the framework's own current docs / website first.** Do not rely on remembered
   APIs, flags, or file conventions — they may already be wrong. If unsure, search for the
   current documentation rather than guessing.
2. **Use the official CLI to scaffold and generate, not a hand-written file.** `pnpm create
   next-app@latest`, `nest new` / `nest g resource`, `go mod init`, `buf generate` (or the
   current canonical protoc workflow — verify which), the chosen ORM/migration tool's own
   generator — whatever the framework's own generator is. If the CLI can produce it,
   hand-authoring it instead is the wrong default, not a style choice.
3. **shadcn/ui specifically** (adopted for the frontend, `apps/web/components.json` +
   `apps/web/src/components/ui`): it is not a versioned dependency you install once —
   components are pulled into the repo via its CLI and the CLI/registry conventions change.
   Re-check its docs each time you add or update a component rather than reusing a pattern
   from memory. **Before any frontend/UI work in `apps/web`** — new pages, new components,
   or edits to existing ones — load the `frontend-design:frontend-design` skill first and
   build with shadcn components (`pnpm dlx shadcn@latest add <component>`) rather than
   hand-rolled markup/CSS. The editor's whole premise is that it must *feel* like Apple
   Photos (§0); templated or ad-hoc styling works against that goal.
4. **Take the current major version as authoritative over anything written in this file or
   the spec.** If the framework's own site says a newer major is current and stable, use
   that, and update this file's stack table to match (§3.1).

   **Real exception, not a hedge:** "current major" only wins when its *ecosystem* has
   caught up. Confirm via the *consuming* tool's own supported-range statement or
   changelog, not just the framework's own release notes — a framework can ship a new major
   before the tools built on it catch up, and this rule exists to use the framework, not to
   blindly chase its version number into a broken toolchain. Any resulting pin goes into
   `docs/90-deferred-register.md` as a `D-xx` with a re-evaluation trigger.
5. **WebGPU and browser support claims specifically**: the spec's "~80%+ support as of
   2026" note is a snapshot. Re-verify current support and the state of the fallback story
   before building on either.

Only fall back to hand-writing when §2.2 applies — no generator covers the case, or the
generated output would need heavy rework anyway.

### 2.1 What this looks like in practice

- **Scaffolding & generators.** `pnpm create next-app@latest`, `nest g resource`,
  `go mod init` / `go mod tidy`, `buf generate` for gRPC stubs (both Go and TS sides from
  the same `.proto` — never hand-synced), the migration tool's own generate/migrate
  commands, `gh repo create`.
- **Media operations go through ffmpeg/libvips, never hand-rolled.** Transcoding,
  resizing, compression, format conversion, audio extraction — Go workers *shell out to or
  bind* these tools; they do not reimplement codecs or resampling. This is a stack-level
  decision (spec, "Go vs TypeScript Split"), not a style preference. The one deliberate
  exception is the editor's WebGPU preview shaders, which *approximate* the same
  operations client-side — and that approximation is bounded by the recipe-fidelity metric
  (§0 Tests), not left to taste.
- **Service operations via official CLI/SDK.** NATS administration via `nats` CLI, object
  storage via `mc` (MinIO client) or the S3 SDK, database work via the migration tool and
  `psql`, GitHub via `gh` — rather than reconstructing requests, SQL, or config by hand.
- **Run the command, then verify the output.** When a reliable, idempotent command does the
  job, run it and check what it produced — do not recreate the result line by line.
- **Use the agent's dedicated tools.** Prefer the purpose-built file read/edit/search tools
  over improvised shell commands (`cat`, `sed`, `awk`, `echo`) when one fits.
- **Respect the project's existing tooling once it exists.** One package manager for the TS
  side (decide at scaffold time, then never mix), `go.mod` for the Go side, generated gRPC
  stubs over hand-written clients.

### 2.2 When to hand-write instead

Hand-writing is correct when: no generator/CLI covers the case; the tool's output would need
heavy rework anyway; or the generated code conflicts with established project conventions.
In those cases, still match the surrounding code's style and idioms, and if a codec flag,
protocol detail, or browser API isn't something you can verify directly, write
`[VERIFY: ...]` rather than guessing.

### 2.3 Why this matters

Less human error, canonical and reproducible output, alignment with the project's existing
tooling — and, for the media paths specifically, correctness and performance that
hand-rolled processing code could not credibly match. The Go/gRPC/ffmpeg choices only pay
off if they are actually used as designed.

---

## 3. Update documentation after executing

**Rule:** Before considering a task **done**, update **all documentation affected** by the
change. Documentation is part of the deliverable, not an optional follow-up.

### 3.1 What to check and update

- **`CLAUDE.md`** — If the change alters architecture, decided stack, conventions, or any
  of the §0 "things that must not break" (non-destructive editing, recipe/pipeline
  unification, no lost jobs), update the corresponding section here.
- **`docs/plexus-media-pipeline-spec.md`** — If the change resolves an Open Question,
  changes a requirement's priority tier, or alters the architecture diagram/split, update
  the specific section, don't just append a note. The spec stays the source of truth for
  *what* Plexus is; this file stays the source of truth for *how* to work on it.
- **`docs/90-deferred-register.md`** — Every time work surfaces a new unverified claim
  (`V-xx`) or deliberate debt (`D-xx`), or resolves an existing one, this file changes in
  the same pass. Never leave a `[VERIFY: ...]` tag written into a doc without a
  corresponding register entry.
- **`.env.example` + deploy/README docs** (once code exists) — Whenever env vars are
  added, renamed, or removed, the example file and the docs must list every variable the
  code reads. They travel together, never separately.
- **`proto/` contracts and their generated stubs** — a `.proto` change is not done until
  both Go and TS stubs are regenerated and committed per the repo's codegen convention.
- **READMEs and GitHub repo metadata** — treat these the same way as
  `docs/90-deferred-register.md`: update them in the same pass, not as a separate later
  step. The root `README.md` (architecture diagram, stack table, phase status, quickstart)
  and each scaffolded app's own `README.md` (`apps/web`, `apps/orchestrator`, `workers/`)
  go stale exactly the way any other doc does — a new package, a renamed endpoint, a status
  change from "proposed" to "scaffolded" (§4's layout table) all apply here too. If the
  change also affects what the repo *is* at a glance — new topics/keywords worth
  discovering it by, a description that no longer matches — update the GitHub repo's own
  description/topics via `gh repo edit`, not just the files inside it. Grep the READMEs for
  the same stale-reference check §3.2 already prescribes for other docs.

### 3.2 How to apply it

- Treat "docs updated" as an explicit checklist item before declaring the task complete.
- When unsure whether a doc is affected, grep for the names of the things you changed
  (processor id, recipe field, NATS subject, env var) across `docs/*.md` to find references
  that went stale.
- Do not silently defer anything found mid-task — route it into
  `docs/90-deferred-register.md` immediately, with the right prefix.

### 3.3 Why this matters

The recipe schema is shared by three consumers (editor, orchestrator, Go render engine) and
the plugin contract is shared with code that lives *outside* this repo. A doc or contract
that silently drifted from the code is exactly how "export doesn't match preview" and
"plugin worked yesterday" bugs happen — the two failure modes this project's success
metrics exist to catch.

---

## 4. Project conventions — polyglot monorepo

**Rule:** One repo, two toolchains, clean boundary. `apps/orchestrator`, `workers/`,
`apps/web`, and `packages/recipe` are scaffolded (`TASK-scaffold-monorepo.md` Phase 1;
`apps/web` via `TASK-editor-scaffold.md`, Phase 2 start; `packages/recipe` via
`TASK-recipe-packages-extraction.md`, Phase 3 start — resolved `D-1`'s `packages/` portion
and `D-17`). `proto/` remains proposed but deliberately not yet created — scaffolded in its
own phase's task doc when Phase 4 actually starts, not up front, per §2.0 (framework
versions drift while unused).

- **Layout (current + proposed):**

  ```
  apps/web            Next.js 16.3 frontend, WebGPU editor to come (TS)   — scaffolded
  apps/orchestrator   NestJS — auth, DAG resolution, job state machine   — scaffolded
  workers/            Go worker pool — built-in processors, export/batch — scaffolded
  proto/              gRPC/protobuf contracts (plugin contract)          — proposed, Phase 4
  packages/recipe     shared Zod recipe/pipeline step schema (TS)        — scaffolded
  infra/              docker-compose.yml — local Postgres + NATS JetStream — scaffolded
  docs/               spec, task docs, deferred register                 — exists
  ```

- **TypeScript side:** package manager is **pnpm** (`pnpm-workspace.yaml`, decided at
  scaffold time per this section's rule); workspace deps (`workspace:*`) for shared code,
  never relative cross-app imports or copy-paste. Each package owns its dependencies —
  declare what you import.
- **Go side:** standard Go module layout under `workers/`, `go.mod` owns versions,
  `go vet`/`golangci-lint` from day one.
- **The gRPC contract in `proto/` is the only interface between the TS and Go worlds**
  (plus NATS subjects and the shared Postgres schema, each owned by exactly one side —
  decide ownership in the scaffold task doc). No JSON shapes duplicated by hand across the
  language boundary: the recipe/pipeline schema gets one canonical definition and
  everything else is generated or imported from it.
- **Mocking the database and the queue is banned in orchestrator domain logic and Go
  workers** — tests there run against real Postgres/NATS/MinIO via testcontainers. This is
  stricter than the generic monorepo convention and is not negotiable per the Tests section
  above.

**Why:** consistent tooling, real code sharing instead of duplication, a language boundary
that stays a *contract* instead of dissolving into copy-paste — and, combined with the
no-mocking rule, tests that can actually catch lost jobs and preview/export drift.

### 4.1 Commit conventions

- **Commit automatically once a task doc's work is complete and verified** (build/lint/tests
  passing per its own scope) — don't wait to be asked for each one. This is a standing
  authorization for this repo, scoped to work that followed the task-doc process in §1; it
  is not blanket permission for destructive git operations (force-push, `reset --hard`,
  etc.), which still require explicit confirmation per the general git safety rules.
- **Never add a `Co-Authored-By` trailer to commits in this repo.** No exceptions.

**Why:** the task-doc-first workflow (§1) already gets alignment before code is written, so
withholding the commit afterward adds a redundant approval step without adding safety. The
no-co-author rule is a standing preference, not situational.

---

## TL;DR

| Phase | Rule | Output |
|-------|------|--------|
| **Stack** | Next.js + WebGPU editor, NestJS orchestrator, Go workers (ffmpeg/libvips), gRPC plugins, NATS JetStream, Postgres, MinIO/S3 (spec-decided; `apps/orchestrator` + `workers/` + `apps/web` + `packages/recipe` scaffolded, rest phased in) | Polyglot monorepo: `apps/web` (scaffolded), `apps/orchestrator` (scaffolded), `workers/` (scaffolded), `packages/recipe` (scaffolded), `proto/` (proposed) |
| **Before** | Write a task document first — including for the initial scaffold | `docs/tasks/TASK-<slug>.md` with: current scenario, planned changes (file by file), why, affected-files table |
| **During** | Use CLIs / generators / SDKs — ffmpeg/libvips for media, `buf`/protoc for gRPC stubs, framework CLIs for scaffolds; never hand-rolled media processing or hand-synced contracts | Canonical, reproducible output; `[VERIFY: ...]` inline for anything unconfirmed |
| **After** | Update all affected documentation, including the deferred register; then commit — auto-committed once verified, never with a `Co-Authored-By` trailer (§4.1) | `CLAUDE.md`, `docs/plexus-media-pipeline-spec.md`, `docs/90-deferred-register.md` (`V-xx`/`D-xx`), regenerated proto stubs, `.env.example`, a commit |

**The loop:** plan → align → build with tooling → document → commit → done. **Never broken:**
non-destructive editing (parameters, never pixel mutations), recipe/pipeline unification
(an editor recipe runs unmodified as a batch pipeline), no lost jobs (a killed worker's job
is picked up by another replica).
