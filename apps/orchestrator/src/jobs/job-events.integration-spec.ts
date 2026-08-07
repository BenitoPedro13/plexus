import { NotFoundException } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Consumer } from '@nats-io/jetstream';
import {
  setupTestBroker,
  type TestBroker,
} from '../../test/support/nats-test-broker';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { JOB_RESULTS_SUBJECT } from '../nats/nats.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import type { StepResultMessage } from './dispatch-message';
import { JobDispatchService } from './job-dispatch.service';
import type { JobProgressEvent } from './job-progress-event';
import { handleStepResult } from './job-result-handler';
import { JobsService } from './jobs.service';

// Polls until `check` returns true or the timeout elapses — SSE events
// arrive off the Observable's own async loop, not synchronously after the
// action that triggers them.
async function waitUntil(
  check: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

describe('JobsService.streamEvents (integration, real Postgres + real NATS)', () => {
  let testDb: TestDb;
  let testBroker: TestBroker;
  let jobDispatchService: JobDispatchService;
  let jobsService: JobsService;
  let pipelinesService: PipelinesService;
  let resultsConsumer: Consumer;

  beforeAll(async () => {
    testDb = await setupTestDb();
    testBroker = await setupTestBroker();
    jobDispatchService = new JobDispatchService(
      testDb.dbService,
      testBroker.natsService,
    );
    jobsService = new JobsService(
      testDb.dbService,
      jobDispatchService,
      testBroker.natsService,
    );
    pipelinesService = new PipelinesService(testDb.dbService);
    resultsConsumer = await testBroker.natsService.durableConsumer(
      JOB_RESULTS_SUBJECT,
      'sse-test-results-consumer',
    );
  }, 120_000);

  afterAll(async () => {
    await testBroker.teardown();
    await testDb.teardown();
  });

  // Drives a step to COMPLETE through the real dispatch-results loop
  // (publish -> pull -> handleStepResult), the same path a real worker's
  // result would take, so this exercises streamEvents' actual NATS-mediated
  // fan-out rather than a shortcut DB write.
  async function completeStep(
    jobId: string,
    jobStepId: string,
    outputRef: string,
  ): Promise<void> {
    await testBroker.natsService.publish(JOB_RESULTS_SUBJECT, {
      jobId,
      jobStepId,
      status: 'complete',
      outputRef,
    } satisfies StepResultMessage);
    const msg = await resultsConsumer.next({ expires: 5_000 });
    await handleStepResult(
      testDb.dbService,
      jobDispatchService,
      testBroker.natsService,
      msg!,
    );
  }

  it('emits a snapshot then live step/job events, completing when the job settles', async () => {
    const pipeline = await pipelinesService.create({
      name: 'sse-two-step',
      steps: [
        { id: 'resize', processor: 'image.resize', params: {} },
        {
          id: 'compress',
          processor: 'image.compress',
          params: {},
          dependsOn: ['resize'],
        },
      ],
    });
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/sse-input.jpg',
    });

    const events: JobProgressEvent[] = [];
    let completed = false;
    const subscription = jobsService.streamEvents(job.id).subscribe({
      next: (message: MessageEvent) =>
        events.push(message.data as JobProgressEvent),
      complete: () => {
        completed = true;
      },
    });

    await waitUntil(() => events.length >= 1);
    expect(events[0]).toMatchObject({
      scope: 'snapshot',
      job: { id: job.id, status: 'RUNNING' },
    });

    await completeStep(job.id, job.steps[0].id, '/tmp/resized.jpg');
    await completeStep(job.id, job.steps[1].id, '/tmp/compressed.jpg');

    await waitUntil(() => completed);
    subscription.unsubscribe();

    expect(events.map((event) => event.scope)).toContain('step');
    expect(events.at(-1)).toMatchObject({ scope: 'job', status: 'COMPLETE' });

    // TASK-step-progress-outputref.md: a completed step's event must carry
    // outputRef so a client can offer a download without waiting for a
    // fresh snapshot -- the earlier symptom was this being silently
    // dropped despite the DB already having the value.
    const compressStepEvent = events.find(
      (event) =>
        event.scope === 'step' &&
        event.stepId === 'compress' &&
        event.status === 'COMPLETE',
    );
    expect(compressStepEvent).toMatchObject({
      scope: 'step',
      status: 'COMPLETE',
      outputRef: '/tmp/compressed.jpg',
    });
  }, 15_000);

  async function failStep(
    jobId: string,
    jobStepId: string,
    error: string,
  ): Promise<void> {
    await testBroker.natsService.publish(JOB_RESULTS_SUBJECT, {
      jobId,
      jobStepId,
      status: 'failed',
      error,
    } satisfies StepResultMessage);
    const msg = await resultsConsumer.next({ expires: 5_000 });
    await handleStepResult(
      testDb.dbService,
      jobDispatchService,
      testBroker.natsService,
      msg!,
    );
  }

  it('closes the stream when a fan-out job settles PARTIAL (TASK-branching-parallel-dags.md)', async () => {
    const pipeline = await pipelinesService.create({
      name: 'sse-fan-out-partial',
      steps: [
        { id: 'root', processor: 'image.resize', params: {} },
        {
          id: 'a',
          processor: 'image.compress',
          params: {},
          dependsOn: ['root'],
        },
        {
          id: 'b',
          processor: 'image.convert',
          params: { format: 'webp' },
          dependsOn: ['root'],
        },
      ],
    });
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/sse-partial-input.jpg',
    });
    const [root, a, b] = job.steps;

    const events: JobProgressEvent[] = [];
    let completed = false;
    const subscription = jobsService.streamEvents(job.id).subscribe({
      next: (message: MessageEvent) =>
        events.push(message.data as JobProgressEvent),
      complete: () => {
        completed = true;
      },
    });

    await waitUntil(() => events.length >= 1);

    await completeStep(job.id, root.id, '/tmp/root-output.jpg');
    await failStep(job.id, a.id, 'boom');
    await completeStep(job.id, b.id, '/tmp/b-output.jpg');

    await waitUntil(() => completed, 10_000);
    subscription.unsubscribe();

    expect(events.at(-1)).toMatchObject({ scope: 'job', status: 'PARTIAL' });
  }, 15_000);

  it('completes immediately with just a snapshot for an already-terminal job', async () => {
    const pipeline = await pipelinesService.create({
      name: 'sse-empty-pipeline',
      steps: [],
    });
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/sse-empty.jpg',
    });
    expect(job.status).toBe('COMPLETE');

    const events: JobProgressEvent[] = [];
    let completed = false;
    jobsService.streamEvents(job.id).subscribe({
      next: (message: MessageEvent) =>
        events.push(message.data as JobProgressEvent),
      complete: () => {
        completed = true;
      },
    });

    await waitUntil(() => completed);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'snapshot',
      job: { status: 'COMPLETE' },
    });
  });

  it('errors for an unknown job id', async () => {
    let error: unknown;
    await new Promise<void>((resolve) => {
      jobsService
        .streamEvents('00000000-0000-0000-0000-000000000000')
        .subscribe({
          error: (err) => {
            error = err;
            resolve();
          },
        });
    });
    expect(error).toBeInstanceOf(NotFoundException);
  });
});
