import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { jobs, jobSteps, type JobStep } from '../db/schema';
import { JOB_DISPATCH_SUBJECT, NatsService } from '../nats/nats.service';
import type { StepDispatchMessage } from './dispatch-message';
import { publishJobProgress } from './job-progress-event';
import { IllegalTransitionError, type JobStatus } from './job-status';
import { transitionJobStatus, tryStartJobStep } from './job-transitions';

@Injectable()
export class JobDispatchService {
  constructor(
    private readonly dbService: DbService,
    private readonly natsService: NatsService,
  ) {}

  // Advances a job by dispatching every currently-ready step — real DAG
  // fan-out (docs/tasks/TASK-branching-parallel-dags.md): more than one
  // step can be ready in the same call, not just the single "next" step a
  // linear chain has. A step is ready once every id in its `dependsOn` is a
  // sibling step with status COMPLETE (empty `dependsOn` => ready
  // immediately, input is the job's own inputRef). Settles the job once no
  // step is PENDING-and-ready and none is RUNNING. Idempotent — safe to
  // call again for a job that's already fully dispatched/settled, which is
  // what makes redelivered result messages recoverable (see
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

    const byStepId = new Map(steps.map((step) => [step.stepId, step]));
    const isReady = (step: JobStep): boolean =>
      step.status === 'PENDING' &&
      step.dependsOn.every(
        (depId) => byStepId.get(depId)?.status === 'COMPLETE',
      );

    const ready = steps.filter(isReady);

    if (ready.length === 0) {
      const stillActive = steps.some(
        (step) => step.status === 'PENDING' || step.status === 'RUNNING',
      );
      if (!stillActive) {
        // Empty pipeline, or every step already COMPLETE/FAILED/SKIPPED.
        await this.ensureRunning(jobId, job.status);
        await this.settle(jobId, steps);
      }
      // Otherwise: at least one step is RUNNING (a later result will
      // re-trigger dispatch), or PENDING-but-blocked on an in-flight
      // dependency — nothing to do yet either way.
      return;
    }

    await this.ensureRunning(jobId, job.status);

    for (const step of ready) {
      // Conditional UPDATE, not SELECT-then-assert: with real parallel
      // branches, sibling steps settling close together routinely trigger
      // concurrent dispatchNext() calls for the same job, which could
      // otherwise both observe this step as ready and double-dispatch it.
      const started = await tryStartJobStep(this.dbService.db, step.id);
      if (!started) {
        continue;
      }

      await publishJobProgress(this.natsService, {
        scope: 'step',
        jobId: job.id,
        jobStepId: started.id,
        stepId: started.stepId,
        order: started.order,
        status: started.status,
      });

      // Fan-in is unsupported (dag.validator.ts), so dependsOn is 0 or 1
      // entries — no inputRefs map is needed.
      const [dependencyId] = started.dependsOn;
      const inputRef = dependencyId
        ? (byStepId.get(dependencyId)?.outputRef ?? job.inputRef)
        : job.inputRef;

      const message: StepDispatchMessage = {
        jobId: job.id,
        jobStepId: started.id,
        stepId: started.stepId,
        processor: started.processor,
        params: started.params,
        inputRef,
        order: started.order,
      };

      await this.natsService.publish(JOB_DISPATCH_SUBJECT, message);
    }
  }

  private async ensureRunning(jobId: string, status: JobStatus): Promise<void> {
    if (status !== 'QUEUED') {
      return;
    }
    try {
      const job = await transitionJobStatus(
        this.dbService.db,
        jobId,
        'RUNNING',
      );
      await publishJobProgress(this.natsService, {
        scope: 'job',
        jobId: job.id,
        status: job.status,
      });
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) {
        throw err;
      }
    }
  }

  // Every step is now COMPLETE/FAILED/SKIPPED (or the pipeline was empty).
  // All COMPLETE => COMPLETE. Zero COMPLETE (nothing ever succeeded — the
  // pre-branching behavior, still exactly what a single-chain pipeline's
  // one failing step produces) => FAILED. A mix of at least one COMPLETE
  // and at least one FAILED/SKIPPED => PARTIAL.
  private async settle(jobId: string, steps: JobStep[]): Promise<void> {
    const completeCount = steps.filter(
      (step) => step.status === 'COMPLETE',
    ).length;
    const to: JobStatus =
      steps.length === 0 || completeCount === steps.length
        ? 'COMPLETE'
        : completeCount === 0
          ? 'FAILED'
          : 'PARTIAL';

    try {
      const job = await transitionJobStatus(this.dbService.db, jobId, to);
      await publishJobProgress(this.natsService, {
        scope: 'job',
        jobId: job.id,
        status: job.status,
      });
    } catch (err) {
      // Already settled by an earlier call (e.g. a redelivered result
      // re-running this method) — not an error.
      if (!(err instanceof IllegalTransitionError)) {
        throw err;
      }
    }
  }
}
