import type { JsMsg } from '@nats-io/jetstream';
import { DbService } from '../db/db.service';
import type { NatsService } from '../nats/nats.service';
import type { StepResultMessage } from './dispatch-message';
import { JobDispatchService } from './job-dispatch.service';
import { publishJobProgress } from './job-progress-event';
import { IllegalTransitionError } from './job-status';
import {
  transitionJobStatus,
  transitionJobStepStatus,
} from './job-transitions';

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

  try {
    const step = await transitionJobStepStatus(
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
      jobStepId: step.id,
      stepId: step.stepId,
      order: step.order,
      status: step.status,
      error: step.error ?? undefined,
    });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) {
      throw err;
    }
  }

  if (result.status === 'failed') {
    try {
      const job = await transitionJobStatus(
        dbService.db,
        result.jobId,
        'FAILED',
      );
      await publishJobProgress(natsService, {
        scope: 'job',
        jobId: job.id,
        status: job.status,
      });
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) {
        throw err;
      }
    }
  } else {
    await jobDispatchService.dispatchNext(result.jobId);
  }

  message.ack();
}
