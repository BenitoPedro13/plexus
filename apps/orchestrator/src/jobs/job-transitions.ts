import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
