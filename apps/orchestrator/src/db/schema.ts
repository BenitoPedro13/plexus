import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const jobStatusEnum = pgEnum('job_status', [
  'QUEUED',
  'RUNNING',
  'PARTIAL',
  'COMPLETE',
  'FAILED',
]);

export const jobStepStatusEnum = pgEnum('job_step_status', [
  'PENDING',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'SKIPPED',
]);

export interface PipelineStepDefinition {
  id: string;
  processor: string;
  params: Record<string, unknown>;
  dependsOn: string[];
}

export const pipelines = pgTable('pipelines', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // Topologically-ordered step list, already validated and dependsOn-resolved
  // by resolveDag() at write time (docs/tasks/TASK-branching-parallel-dags.md)
  // — array index is a display/debug order, not the execution order; a
  // step's real predecessors are its own dependsOn entries.
  definition: jsonb('definition').$type<PipelineStepDefinition[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id')
    .notNull()
    .references(() => pipelines.id),
  status: jobStatusEnum('status').notNull().default('QUEUED'),
  // Opaque input location for Phase 1 (e.g. a local filesystem path). Object
  // storage / presigned upload wiring is deferred to Phase 3 (see D-3).
  inputRef: text('input_ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const jobSteps = pgTable('job_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id),
  stepId: text('step_id').notNull(),
  processor: text('processor').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  // Step ids (this job's own jobSteps.stepId values, not row ids) this step
  // depends on — copied from the owning pipeline's definition at job-creation
  // time, same pattern processor/params already use. Drives
  // JobDispatchService's ready-step computation; empty means "ready as soon
  // as the job starts, input is the job's own inputRef."
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  order: integer('order').notNull(),
  status: jobStepStatusEnum('status').notNull().default('PENDING'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Where this step's output landed once COMPLETE. The next step's
  // dispatch inputRef is chained from this (see JobDispatchService).
  outputRef: text('output_ref'),
  error: text('error'),
});

export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobStep = typeof jobSteps.$inferSelect;
export type NewJobStep = typeof jobSteps.$inferInsert;
