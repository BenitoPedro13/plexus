# TASK — Job State Machine (Phase 1, slice 1)

## Cenário actual

`apps/orchestrator` is a bare `nest new`-scaffolded NestJS 11 app (`TASK-scaffold-monorepo.md`):
only `app.controller.ts` / `app.service.ts` / `app.module.ts`, no domain modules, no database
client, no migrations. `workers/` is a bare Go module with an empty `cmd/worker/main.go`.
`infra/docker-compose.yml` runs Postgres 18.4 and NATS 2.14.4 (JetStream enabled), both
healthy, but nothing in the orchestrator talks to either yet. `.env.example` already declares
`DATABASE_URL` and `NATS_URL`.

Per the spec's phasing (`docs/plexus-media-pipeline-spec.md` "Suggested Phasing"), Phase 1 is
"Orchestrator + single Go worker type + Postgres + NATS. Linear (non-branching) pipelines
only. Built-in processors: resize, convert, compress." That's too much for one task doc, so
this is **slice 1 of Phase 1**: the orchestrator's persistence layer and job state machine,
with no NATS dispatch and no Go worker execution yet. Nothing currently defines what a
pipeline definition or a job even *is* in code — this task creates those domain models for
the first time.

## Mudanças planeadas

### 1. Data layer — Drizzle, chosen over Prisma/TypeORM

- **`apps/orchestrator/src/db/schema.ts`** (new) — Drizzle schema (`pgTable`/`pgEnum` from
  `drizzle-orm/pg-core`) with three tables:
  - `pipelines`: `id` (uuid, pk, `defaultRandom()`), `name` (text), `definition` (jsonb —
    the validated, ordered step list), `createdAt` (timestamp, default now).
  - `jobs`: `id` (uuid, pk), `pipelineId` (uuid, fk → `pipelines.id`), `status`
    (`pgEnum jobStatus`: `QUEUED | RUNNING | PARTIAL | COMPLETE | FAILED`), `inputRef` (text
    — see "input handling" below), `createdAt`, `updatedAt`.
  - `jobSteps`: `id` (uuid, pk), `jobId` (uuid, fk → `jobs.id`), `stepId` (text, matches the
    step id from the pipeline definition, e.g. `"resize"`), `processor` (text, e.g.
    `"image.resize"`), `params` (jsonb), `order` (integer — resolved linear position,
    0-based), `status` (`pgEnum jobStepStatus`: `PENDING | RUNNING | COMPLETE | FAILED |
    SKIPPED`), `startedAt`, `completedAt`, `error` (text, nullable).
- **`apps/orchestrator/drizzle.config.ts`** (new) — `drizzle-kit` config: schema path,
  `out: "./drizzle/migrations"`, `dialect: "postgresql"`, credentials from `DATABASE_URL`.
- **`apps/orchestrator/drizzle/migrations/`** (new) — generated via `drizzle-kit generate`,
  applied via `drizzle-kit migrate`; never hand-written, per CLAUDE.md §2.
- **`apps/orchestrator/src/db/db.service.ts`** (new) — wraps `drizzle(pool, { schema })`
  (driver: `drizzle-orm/node-postgres` over a `pg.Pool`, the canonical pairing per Drizzle's
  own docs) as a Nest injectable with `onModuleDestroy` closing the pool. `DbModule` is
  `@Global()`, exported once from `AppModule`.
- Dependencies added to `apps/orchestrator/package.json`: `drizzle-orm`, `pg` (runtime);
  `drizzle-kit`, `@types/pg` (dev). `[VERIFY: exact current versions at install time via
  `pnpm add drizzle-orm pg` / `pnpm add -D drizzle-kit @types/pg`]`.

**Changed from the original plan (Prisma) after review:** Prisma still has no native
PostGIS geometry/geography column support as of 2026 — confirmed still open
([prisma/prisma#25768](https://github.com/prisma/prisma/issues/25768)), raw-SQL/extension
workarounds only. That's not hypothetical for this project: an editor explicitly modeled on
Apple Photos (spec §"Image Editor") plausibly grows a Places/map view from photo EXIF GPS
data later, which is exactly the kind of feature Prisma would fight. Drizzle is SQL-first —
mixing a raw `sql` column type or a `postgis` extension migration in later doesn't require
fighting a separate schema DSL or waiting on ORM-level feature support. Combined with
Drizzle now being the more commonly recommended default for new NestJS+Postgres projects
(faster, no query-engine binary, migrations are inspectable SQL files), this outweighs
Prisma's slightly more polished first-party NestJS recipe. No PostGIS work happens in this
task — this is purely about not picking a data layer that would need replacing later.
Recorded as a decision in `docs/90-deferred-register.md` (new "Resolved" entry, not a V/D —
this isn't a spec Open Question, just a data-layer choice this task is making for the first
time).

### 2. Pipeline module — definition + linear-DAG validation

- **`apps/orchestrator/src/pipelines/pipelines.module.ts`** (new)
- **`apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts`** (new) — `class-validator`
  DTO: `name: string`, `steps: StepDto[]` where `StepDto` is `{ id: string, processor:
  string, params: Record<string, unknown>, dependsOn?: string[] }` — mirrors the spec's YAML
  shape (`docs/plexus-media-pipeline-spec.md` "Core Concepts") but accepted as JSON for now;
  YAML parsing is not in scope for this slice (noted below).
- **`apps/orchestrator/src/pipelines/linear-dag.validator.ts`** (new) — pure function
  `resolveLinearOrder(steps: StepDto[]): StepDto[] | ValidationError`. Enforces Phase 1's
  "linear (non-branching) pipelines only": exactly one step with no `dependsOn` (the root),
  every other step has exactly one `dependsOn` entry, no step is depended on by more than one
  other step, no cycles, every referenced id exists. Rejects anything else with a specific
  error (branching, multiple roots, missing dependency, cycle) rather than a generic
  "invalid pipeline." Returns steps in resolved execution order.
- **`apps/orchestrator/src/pipelines/pipelines.service.ts`** (new) — `create()` runs the DTO
  through `resolveLinearOrder`, persists a `pipelines` row with `definition` set to the
  *resolved-order* step array (so `jobSteps.order` can just be the array index later, no
  re-resolution at job-creation time). `findOne()`.
- **`apps/orchestrator/src/pipelines/pipelines.controller.ts`** (new) — `POST /pipelines`,
  `GET /pipelines/:id`.

Built-in processor identifiers (`image.resize`, `image.convert`, `image.compress` — per spec
Phase 1) are validated as a known-set enum at this layer, even though nothing executes them
yet — rejecting an unknown processor name at pipeline-creation time is cheap and avoids
silently accepting garbage.

### 3. Job module — the state machine itself

- **`apps/orchestrator/src/jobs/jobs.module.ts`** (new)
- **`apps/orchestrator/src/jobs/dto/create-job.dto.ts`** (new) — `{ pipelineId: string,
  inputRef: string }`.
- **`apps/orchestrator/src/jobs/job-status.ts`** (new) — the state machine's legal-transition
  table as data, not scattered `if`s:
  - Job: `QUEUED → RUNNING`, `RUNNING → PARTIAL`, `RUNNING → COMPLETE`, `RUNNING → FAILED`,
    `PARTIAL → RUNNING`. Any other transition throws `IllegalTransitionError`.
  - JobStep: `PENDING → RUNNING`, `RUNNING → COMPLETE`, `RUNNING → FAILED`. (`SKIPPED` is
    reserved for future branching pipelines — Phase 1 is linear, so nothing produces it yet;
    kept in the enum so the Phase 3 DAG work doesn't need a migration to add it.)
- **`apps/orchestrator/src/jobs/jobs.service.ts`** (new) — `create()`: loads the `pipelines`
  row, materializes one `jobSteps` row per resolved step (status `PENDING`, `order` = array
  index), creates the `jobs` row (status `QUEUED`), all inside one Drizzle transaction
  (`db.transaction(...)`). `transitionJob()` / `transitionStep()`: apply the table above,
  persist, throw on illegal transitions. `findOne()` returns the job with its ordered steps
  (a `with`/relational query, or an explicit join — `[VERIFY: relational query API surface
  at implementation time against current drizzle-orm docs]`). **No NATS publish here** — see
  "Explicitly out of scope" below.
- **`apps/orchestrator/src/jobs/jobs.controller.ts`** (new) — `POST /jobs`, `GET /jobs/:id`.

### 4. Tests — real Postgres via testcontainers, no mocking

- **`apps/orchestrator/package.json`** — add `testcontainers` and
  `@testcontainers/postgresql` as dev dependencies.
- **`apps/orchestrator/test/support/postgres-test-db.ts`** (new) — starts a
  `PostgreSqlContainer`, runs `drizzle-kit migrate` (or applies the generated SQL directly)
  against it, returns a connected Drizzle client and a teardown function. Shared by all
  integration tests below.
- **`apps/orchestrator/src/pipelines/pipelines.service.integration-spec.ts`** (new) — real
  Postgres: valid linear chain persists correctly; branching/multi-root/cyclic/unknown-dep
  definitions are all rejected with the specific error each case should produce; unknown
  processor id rejected.
- **`apps/orchestrator/src/jobs/jobs.service.integration-spec.ts`** (new) — real Postgres:
  `create()` materializes the right number of `PENDING` steps in the right order;
  `transitionJob`/`transitionStep` accept every legal transition in the table and reject
  every illegal one tried (e.g. `QUEUED → COMPLETE` directly, `COMPLETE → RUNNING`).
  Per CLAUDE.md's "Things that must not break — No lost jobs," this is also where that
  guarantee starts being testable: a job's per-step status is durable in Postgres, not
  in-memory, so a crash between step transitions leaves recoverable state — full
  crash-recovery/redelivery is Phase 1 slice 2's job (NATS + worker), but the persistence
  this task builds is the precondition for it.
- Existing `app.controller.spec.ts` (unit, no DB) is untouched.

### Explicitly out of scope for this task (deferred to the next slice)

- **NATS publish/consume** — `jobs.service.ts.create()` persists a `QUEUED` job and stops;
  nothing dispatches it anywhere yet. Next task: `TASK-nats-job-dispatch.md`.
- **Go worker execution** — `workers/cmd/worker/main.go` stays a bare stub in this task.
- **Object storage / presigned upload** — `Job.inputRef` is accepted as an opaque string
  (e.g. a local filesystem path during Phase 1 dev/testing) with no validation of what it
  points to. Per `docs/90-deferred-register.md` D-3, object storage choice isn't resolved
  until Phase 3's presigned-upload task; Phase 1 doesn't need it to prove the state machine.
- **YAML pipeline definitions** — spec's Core Concepts example is YAML; this task accepts
  JSON only (the `class-validator` DTO shape above). YAML is a thin parsing layer on top of
  the same DTO and is deferred to whichever task first needs the CLI/UI authoring path — not
  needed to prove the state machine itself. New deferred-register entry (see §Ficheiros
  afectados).
- **Retry/backoff for failed steps** — spec marks this P1. A `FAILED` step fails the job;
  no automatic retry.
- **SSE/WebSocket progress** — spec's realtime requirement is Phase 3. This task's state
  transitions are just Postgres writes for now.

## Porquê

The spec's Phase 1 bundles orchestrator, one Go worker, Postgres, and NATS into a single
phase, but none of those four pieces has any code yet — trying to stand all of them up in one
task doc would make the doc (and the review of it) unreviewably large, and would hide the
real decision points (ORM choice, linear-DAG validation rules, exact state-transition table)
inside a wall of unrelated NATS/Go plumbing. Splitting slice 1 (persistence + state machine,
orchestrator-only) from slice 2 (NATS dispatch + Go worker execution) means slice 1 can be
reviewed and tested completely on its own — "create a pipeline, create a job against it, walk
every legal/illegal state transition, all against a real Postgres" — before anything about
message queues or Go enters the picture. This also matches CLAUDE.md §0's "Tests" section
directly: testcontainers-backed integration tests are possible for this slice *today*, so
there's no reason to defer them behind the NATS/worker wiring.

Drizzle over Prisma/TypeORM: `drizzle-kit generate`/`migrate` is a real CLI-generated
migration workflow too, so it still satisfies CLAUDE.md §2's "use the framework's own
canonical tooling" — the deciding factor is PostGIS. Prisma's lack of native
geometry/geography support is a known, still-open gap (not this project's first time
hitting it — see the file-table's deferred-register note), and this project has a concrete,
plausible future need for it (Places/map view from photo GPS EXIF, in keeping with the
Apple Photos reference the whole editor spec is built around). Paying that cost later, after
jobs/pipelines/recipes tables already exist under Prisma, would be a much more disruptive
migration than choosing the SQL-first tool now, before any schema exists. Performance is a
secondary factor, not the deciding one — nothing in Phase 1 is throughput-sensitive at the
ORM layer (that's the Go workers' job, per the Go/TS split's own justification).

The linear-DAG validator being a named, testable pure function (rather than inline logic in
the service) matters because Phase 3 replaces it with real branching-DAG resolution — having
it isolated now means that swap doesn't require touching `pipelines.service.ts`'s
persistence logic at all.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/src/db/schema.ts` | new | `pipelines`, `jobs`, `jobSteps` tables + `jobStatus`/`jobStepStatus` pg enums |
| `apps/orchestrator/drizzle.config.ts` | new | `drizzle-kit` config (schema path, migrations out dir, `DATABASE_URL`) |
| `apps/orchestrator/drizzle/migrations/` | new | generated by `drizzle-kit generate`, not hand-written |
| `apps/orchestrator/src/db/db.service.ts` | new | injectable Drizzle client over a `pg.Pool`, Nest lifecycle hooks |
| `apps/orchestrator/src/db/db.module.ts` | new | `@Global()` module exporting `DbService` |
| `apps/orchestrator/src/pipelines/pipelines.module.ts` | new | |
| `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts` | new | `class-validator` DTO |
| `apps/orchestrator/src/pipelines/linear-dag.validator.ts` | new | pure function, Phase 1 linear-only enforcement |
| `apps/orchestrator/src/pipelines/pipelines.service.ts` | new | |
| `apps/orchestrator/src/pipelines/pipelines.controller.ts` | new | `POST /pipelines`, `GET /pipelines/:id` |
| `apps/orchestrator/src/pipelines/pipelines.service.integration-spec.ts` | new | real Postgres via testcontainers |
| `apps/orchestrator/src/jobs/jobs.module.ts` | new | |
| `apps/orchestrator/src/jobs/dto/create-job.dto.ts` | new | |
| `apps/orchestrator/src/jobs/job-status.ts` | new | legal-transition table for jobs and job steps |
| `apps/orchestrator/src/jobs/jobs.service.ts` | new | `create`, `transitionJob`, `transitionStep`, `findOne` |
| `apps/orchestrator/src/jobs/jobs.controller.ts` | new | `POST /jobs`, `GET /jobs/:id` |
| `apps/orchestrator/src/jobs/jobs.service.integration-spec.ts` | new | real Postgres via testcontainers |
| `apps/orchestrator/test/support/postgres-test-db.ts` | new | shared testcontainers Postgres bootstrap + migrate |
| `apps/orchestrator/src/app.module.ts` | edit | import `DbModule`, `PipelinesModule`, `JobsModule` |
| `apps/orchestrator/package.json` | edit | add `drizzle-orm`, `pg`, `drizzle-kit`, `@types/pg`, `testcontainers`, `@testcontainers/postgresql`, `class-validator`, `class-transformer` |
| `.env.example` | edit | none expected (`DATABASE_URL` already present); confirm no new vars needed once Drizzle is wired |
| `docs/90-deferred-register.md` | edit | resolve "data layer" as a new Resolved entry (Drizzle over Prisma, PostGIS-driven); add new D-xx for YAML pipeline-definition parsing deferral |
| `CLAUDE.md` | edit | update stack table's `Data` row from "PostgreSQL" (unspecified access layer) to name Drizzle explicitly, since this is the first task to pick one; re-check rest of file per §3.1 |

