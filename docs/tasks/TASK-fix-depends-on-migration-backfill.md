# TASK: Fix `job_steps.depends_on` migration failing on existing rows

## Cenário actual

The orchestrator dev server crashes on boot (`DbService.onModuleInit` →
`drizzle-orm/node-postgres/migrator`) trying to run migration
`apps/orchestrator/drizzle/migrations/0002_sparkling_viper.sql`:

```sql
ALTER TABLE "job_steps" ADD COLUMN "depends_on" jsonb NOT NULL;
```

Postgres rejects this with `23502 column "depends_on" of relation "job_steps"
contains null values`, because the local dev DB already has 2 `job_steps` rows
(both `resize` steps, `order = 0`) created before the branching/parallel DAG
feature (`5b6d667 Implement branching/parallel DAG pipelines`) added the
`dependsOn` column to `apps/orchestrator/src/db/schema.ts`. `ADD COLUMN ...
NOT NULL` with no default cannot backfill those rows, so the whole migration
transaction rolls back every time the orchestrator starts.

Confirmed via `drizzle.__drizzle_migrations`: only migrations `0000` and
`0001` are recorded as applied — `0002` has never successfully committed, so
this is safe to correct in place rather than layer a new migration on top.
`5b6d667` (which added `0002_sparkling_viper.sql`) is a local commit, not yet
pushed to `origin/main`, so rewriting it doesn't disturb any shared history.

## Mudanças planeadas

- `apps/orchestrator/src/db/schema.ts` — give `jobSteps.dependsOn` a
  `.default([])` at the schema level. Semantically this is correct, not just
  a migration workaround: the column's own comment already defines "empty ==
  ready as soon as the job starts", which is exactly what the two pre-DAG,
  single-step rows represent. Existing rows get backfilled to `[]` instead of
  needing a hand-written data migration.
- `apps/orchestrator/drizzle/migrations/0002_sparkling_viper.sql` +
  `apps/orchestrator/drizzle/migrations/meta/0002_snapshot.json` +
  `apps/orchestrator/drizzle/migrations/meta/_journal.json` — regenerate via
  `drizzle-kit generate` (not hand-edited SQL) so the emitted statement
  becomes `ADD COLUMN "depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL`,
  which both satisfies the NOT NULL constraint for existing rows and matches
  the schema change above.
- No application code changes: `JobDispatchService` and job-creation code
  already treat an empty `dependsOn` array as "ready immediately", so the
  default doesn't change runtime behaviour for newly created jobs (they
  always pass an explicit `dependsOn`, populated from the pipeline
  definition).

## Porquê

Local dev startup is fully blocked — the orchestrator cannot boot at all
until this migration succeeds. The fix is a schema-level default, not a
migration hand-patch, because `[]` (no dependencies) is a legitimate value
for `dependsOn`, not a placeholder — it's the correct state for the
single-linear-step pipelines that predate the DAG feature. Regenerating with
`drizzle-kit generate` rather than hand-editing the emitted SQL keeps the
migration canonical and keeps `meta/0002_snapshot.json` in sync with the
schema, per `CLAUDE.md` §2 (use the tool's own generator, don't hand-author
what it produces).

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/src/db/schema.ts` | edit | add `.default([])` to `jobSteps.dependsOn` |
| `apps/orchestrator/drizzle/migrations/0002_sparkling_viper.sql` | regenerate | `drizzle-kit generate`, adds `DEFAULT '[]'::jsonb` |
| `apps/orchestrator/drizzle/migrations/meta/0002_snapshot.json` | regenerate | drizzle-kit output, kept in sync with schema |
| `apps/orchestrator/drizzle/migrations/meta/_journal.json` | regenerate | drizzle-kit output (only if journal entry changes) |
