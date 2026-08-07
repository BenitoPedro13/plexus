import type { JsMsg } from '@nats-io/jetstream';
import { DbService } from '../db/db.service';
import type { StepResultMessage } from './dispatch-message';
import { JobDispatchService } from './job-dispatch.service';
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
  message: JsMsg,
): Promise<void> {
  const result = message.json<StepResultMessage>();

  try {
    await transitionJobStepStatus(
      dbService.db,
      result.jobStepId,
      result.status === 'complete' ? 'COMPLETE' : 'FAILED',
      { outputRef: result.outputRef, error: result.error },
    );
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) {
      throw err;
    }
  }

  if (result.status === 'failed') {
    try {
      await transitionJobStatus(dbService.db, result.jobId, 'FAILED');
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
