import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { jobs, jobSteps } from '../db/schema';
import { JOB_DISPATCH_SUBJECT, NatsService } from '../nats/nats.service';
import type { StepDispatchMessage } from './dispatch-message';
import { IllegalTransitionError, type JobStatus } from './job-status';
import {
  transitionJobStatus,
  transitionJobStepStatus,
} from './job-transitions';

@Injectable()
export class JobDispatchService {
  constructor(
    private readonly dbService: DbService,
    private readonly natsService: NatsService,
  ) {}

  // Advances a linear job by one step: dispatches the next PENDING step, or
  // settles the job as COMPLETE once every step is COMPLETE. Idempotent —
  // safe to call again for a job that's already fully dispatched/settled,
  // which is what makes redelivered result messages recoverable (see
  // JobResultConsumerService).
  async dispatchNext(jobId: string): Promise<void> {
    const [job] = await this.dbService.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId));
    if (!job) {
      throw new NotFoundException(`Job "${jobId}" not found`);
    }

    const steps = await this.dbService.db
      .select()
      .from(jobSteps)
      .where(eq(jobSteps.jobId, jobId))
      .orderBy(asc(jobSteps.order));

    const next = steps.find((step) => step.status === 'PENDING');

    if (!next) {
      // Empty pipeline or every step already COMPLETE — nothing left to
      // dispatch. A step still RUNNING means another in-flight dispatch
      // will drive the next call; do nothing.
      if (
        steps.length === 0 ||
        steps.every((step) => step.status === 'COMPLETE')
      ) {
        await this.ensureRunning(jobId, job.status);
        await this.settleComplete(jobId);
      }
      return;
    }

    await this.ensureRunning(jobId, job.status);
    await transitionJobStepStatus(this.dbService.db, next.id, 'RUNNING');

    const previous =
      next.order > 0
        ? steps.find((step) => step.order === next.order - 1)
        : undefined;

    const message: StepDispatchMessage = {
      jobId: job.id,
      jobStepId: next.id,
      stepId: next.stepId,
      processor: next.processor,
      params: next.params,
      inputRef: previous?.outputRef ?? job.inputRef,
      order: next.order,
    };

    await this.natsService.publish(JOB_DISPATCH_SUBJECT, message);
  }

  private async ensureRunning(jobId: string, status: JobStatus): Promise<void> {
    if (status !== 'QUEUED' && status !== 'PARTIAL') {
      return;
    }
    try {
      await transitionJobStatus(this.dbService.db, jobId, 'RUNNING');
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) {
        throw err;
      }
    }
  }

  private async settleComplete(jobId: string): Promise<void> {
    try {
      await transitionJobStatus(this.dbService.db, jobId, 'COMPLETE');
    } catch (err) {
      // Already settled by an earlier call (e.g. a redelivered result
      // re-running this method) — not an error.
      if (!(err instanceof IllegalTransitionError)) {
        throw err;
      }
    }
  }
}
