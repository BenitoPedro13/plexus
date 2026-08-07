import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { jobs, jobSteps, type Job, type JobStep } from '../db/schema';
import * as schema from '../db/schema';
import {
  assertJobStepTransition,
  assertJobTransition,
  type JobStatus,
  type JobStepStatus,
} from './job-status';

type Database = NodePgDatabase<typeof schema>;

export interface JobStepTransitionOptions {
  outputRef?: string;
  error?: string;
}

// DB-aware transition primitives, factored out of JobsService so that
// JobDispatchService/JobResultConsumerService can apply transitions
// directly without depending on JobsService (which itself depends on
// JobDispatchService to trigger dispatch after create() — depending on it
// back would be a circular provider dependency).

export async function transitionJobStatus(
  db: Database,
  id: string,
  to: JobStatus,
): Promise<Job> {
  const [current] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!current) {
    throw new NotFoundException(`Job "${id}" not found`);
  }

  assertJobTransition(current.status, to);

  const [updated] = await db
    .update(jobs)
    .set({ status: to, updatedAt: new Date() })
    .where(eq(jobs.id, id))
    .returning();

  return updated;
}

// Atomic PENDING -> RUNNING transition (conditional UPDATE, not
// SELECT-then-assert): with real parallel branches, sibling steps settling
// close together routinely trigger concurrent JobDispatchService.dispatchNext()
// calls for the same job, which could otherwise both observe the same step
// as ready and double-dispatch it. Returns undefined if another call already
// claimed the step (WHERE ... AND status = 'PENDING' matched zero rows) —
// callers treat that as "not mine, skip," not an error.
export async function tryStartJobStep(
  db: Database,
  id: string,
): Promise<JobStep | undefined> {
  const [updated] = await db
    .update(jobSteps)
    .set({ status: 'RUNNING', startedAt: new Date() })
    .where(and(eq(jobSteps.id, id), eq(jobSteps.status, 'PENDING')))
    .returning();

  return updated;
}

export async function transitionJobStepStatus(
  db: Database,
  id: string,
  to: JobStepStatus,
  opts: JobStepTransitionOptions = {},
): Promise<JobStep> {
  const [current] = await db.select().from(jobSteps).where(eq(jobSteps.id, id));
  if (!current) {
    throw new NotFoundException(`Job step "${id}" not found`);
  }

  assertJobStepTransition(current.status, to);

  const now = new Date();
  const [updated] = await db
    .update(jobSteps)
    .set({
      status: to,
      startedAt: to === 'RUNNING' ? now : current.startedAt,
      completedAt:
        to === 'COMPLETE' || to === 'FAILED' ? now : current.completedAt,
      outputRef: opts.outputRef ?? current.outputRef,
      error: opts.error ?? current.error,
    })
    .where(eq(jobSteps.id, id))
    .returning();

  return updated;
}
