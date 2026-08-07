import type { Job, JobStep } from '../db/schema';
import { jobEventsSubject, type NatsService } from '../nats/nats.service';
import type { JobStatus, JobStepStatus } from './job-status';

// Payloads published to plexus.events.jobs.<jobId> (see nats.service.ts for
// why this is a separate stream/subject prefix from plexus.jobs.>) and
// consumed by JobsService.streamEvents' SSE handler. `snapshot` is
// synthesized directly from a DB row (same shape JobsService.findOne
// already returns), never published over NATS — it only exists as the SSE
// stream's own first emitted event.
export type JobProgressEvent =
  | {
      scope: 'snapshot';
      job: Job & { steps: JobStep[] };
    }
  | {
      scope: 'job';
      jobId: string;
      status: JobStatus;
    }
  | {
      scope: 'step';
      jobId: string;
      jobStepId: string;
      stepId: string;
      order: number;
      status: JobStepStatus;
      error?: string;
    };

export function isTerminalJobProgressEvent(event: JobProgressEvent): boolean {
  const status =
    event.scope === 'snapshot'
      ? event.job.status
      : event.scope === 'job'
        ? event.status
        : undefined;
  return status === 'COMPLETE' || status === 'FAILED';
}

export async function publishJobProgress(
  natsService: NatsService,
  event: Extract<JobProgressEvent, { scope: 'job' | 'step' }>,
): Promise<void> {
  await natsService.publish(jobEventsSubject(event.jobId), event);
}
