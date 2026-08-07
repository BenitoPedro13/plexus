import type { JsMsg } from '@nats-io/jetstream';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { jobSteps, type JobStep } from '../db/schema';
import type { NatsService } from '../nats/nats.service';
import type { StepResultMessage } from './dispatch-message';
import { JobDispatchService } from './job-dispatch.service';
import { publishJobProgress } from './job-progress-event';
import { IllegalTransitionError } from './job-status';
import { transitionJobStepStatus } from './job-transitions';

// Applies a step result and advances the job. Factored out of
// JobResultConsumerService so tests can drive it directly against a single
// pulled JsMsg (e.g. to exercise redelivery) without racing the service's
// own background consume() loop, which binds the one durable consumer a
// WorkQueue-retention stream allows per subject.
//
// At-least-once delivery means this can run more than once for the same
// message (a crash after the DB write but before ack(), or an explicit
// nak/redelivery). The step transition becoming an IllegalTransitionError on
// a re-run (already COMPLETE/FAILED) is treated as "already applied", not an
// error — and dispatchNext() is still called in that case, so a crash
// between the step write and the original dispatch/ack doesn't strand the
// job.
export async function handleStepResult(
  dbService: DbService,
  jobDispatchService: JobDispatchService,
  natsService: NatsService,
  message: JsMsg,
): Promise<void> {
  const result = message.json<StepResultMessage>();

  let appliedStep: JobStep | undefined;
  try {
    appliedStep = await transitionJobStepStatus(
      dbService.db,
      result.jobStepId,
      result.status === 'complete' ? 'COMPLETE' : 'FAILED',
      { outputRef: result.outputRef, error: result.error },
    );
    // Only publish when the transition actually applied — on a redelivered
    // message that's already COMPLETE/FAILED this throws
    // IllegalTransitionError instead (caught below) and nothing publishes,
    // so redelivery never double-publishes a step event.
    await publishJobProgress(natsService, {
      scope: 'step',
      jobId: result.jobId,
      jobStepId: appliedStep.id,
      stepId: appliedStep.stepId,
      order: appliedStep.order,
      status: appliedStep.status,
      error: appliedStep.error ?? undefined,
      outputRef: appliedStep.outputRef ?? undefined,
    });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) {
      throw err;
    }
  }

  // A failed step doesn't fail the whole job outright — its own branch is
  // cascaded to SKIPPED (docs/tasks/TASK-branching-parallel-dags.md), and
  // independent sibling branches keep running. dispatchNext()'s own
  // settlement logic decides the final COMPLETE/FAILED/PARTIAL outcome once
  // every step is terminal, exactly the same call path the success case
  // already uses.
  if (result.status === 'failed') {
    await cascadeSkipDescendants(
      dbService,
      natsService,
      result.jobId,
      result.jobStepId,
    );
  }

  await jobDispatchService.dispatchNext(result.jobId);

  message.ack();
}

// Walks the (fan-in-free, so strictly tree-shaped) subtree of steps that
// transitively depend on `failedJobStepId` and are still PENDING,
// transitioning each to SKIPPED. Idempotent: an already-SKIPPED step (a
// redelivered cascade) throws IllegalTransitionError, which is caught and
// treated as "already applied" — the walk still continues into that step's
// own children, since which parts of a cascade already landed can vary
// across redeliveries.
async function cascadeSkipDescendants(
  dbService: DbService,
  natsService: NatsService,
  jobId: string,
  failedJobStepId: string,
): Promise<void> {
  const steps = await dbService.db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, jobId));

  const failedStep = steps.find((step) => step.id === failedJobStepId);
  if (!failedStep) {
    return;
  }

  const childrenOf = new Map<string, JobStep[]>();
  for (const step of steps) {
    for (const parentStepId of step.dependsOn) {
      childrenOf.set(parentStepId, [
        ...(childrenOf.get(parentStepId) ?? []),
        step,
      ]);
    }
  }

  const queue = [...(childrenOf.get(failedStep.stepId) ?? [])];
  while (queue.length > 0) {
    const child = queue.shift()!;

    if (child.status === 'PENDING' || child.status === 'SKIPPED') {
      try {
        const skipped = await transitionJobStepStatus(
          dbService.db,
          child.id,
          'SKIPPED',
          { error: `Skipped: ancestor step "${failedStep.stepId}" failed` },
        );
        await publishJobProgress(natsService, {
          scope: 'step',
          jobId,
          jobStepId: skipped.id,
          stepId: skipped.stepId,
          order: skipped.order,
          status: skipped.status,
          error: skipped.error ?? undefined,
        });
      } catch (err) {
        if (!(err instanceof IllegalTransitionError)) {
          throw err;
        }
      }
      queue.push(...(childrenOf.get(child.stepId) ?? []));
    }
    // A descendant in any other status (COMPLETE/RUNNING/FAILED) shouldn't
    // be reachable — dispatch only ever starts a step once every dependency
    // is COMPLETE, and a failed ancestor can never satisfy that — but if it
    // somehow is, stop walking that branch rather than skip work already
    // in flight or settled.
  }
}
