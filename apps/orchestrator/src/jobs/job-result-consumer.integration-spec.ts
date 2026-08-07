import {
  setupTestBroker,
  type TestBroker,
} from '../../test/support/nats-test-broker';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { JOB_RESULTS_SUBJECT } from '../nats/nats.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import type { StepResultMessage } from './dispatch-message';
import { JobDispatchService } from './job-dispatch.service';
import { handleStepResult } from './job-result-handler';
import {
  JOB_RESULTS_DURABLE_NAME,
  JobResultConsumerService,
} from './job-result-consumer.service';
import { JobsService } from './jobs.service';

// Polls until `check` returns true or the timeout elapses — the consumer
// service processes results off a background loop, so assertions on its
// effect can't happen synchronously after publish().
async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

describe('JobResultConsumerService (integration, real Postgres + real NATS)', () => {
  let testDb: TestDb;
  let testBroker: TestBroker;
  let jobDispatchService: JobDispatchService;
  let jobsService: JobsService;
  let pipelinesService: PipelinesService;
  let resultConsumer: JobResultConsumerService;

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
    resultConsumer = new JobResultConsumerService(
      testDb.dbService,
      testBroker.natsService,
      jobDispatchService,
    );
    await resultConsumer.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    await resultConsumer.onModuleDestroy();
    await testBroker.teardown();
    await testDb.teardown();
  });

  it('a complete result for step 1 of a 2-step job advances it and dispatches step 2', async () => {
    const pipeline = await pipelinesService.create({
      name: 'two-step',
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
      inputRef: '/tmp/step1-input.jpg',
    });
    const [resizeStep, compressStep] = job.steps;

    const result: StepResultMessage = {
      jobId: job.id,
      jobStepId: resizeStep.id,
      status: 'complete',
      outputRef: '/tmp/resized.jpg',
    };
    await testBroker.natsService.publish(JOB_RESULTS_SUBJECT, result);

    await waitUntil(async () => {
      const fetched = await jobsService.findOne(job.id);
      return (
        fetched.steps.find((s) => s.id === resizeStep.id)?.status === 'COMPLETE'
      );
    });

    const afterFirst = await jobsService.findOne(job.id);
    expect(
      afterFirst.steps.find((s) => s.id === resizeStep.id)?.outputRef,
    ).toBe('/tmp/resized.jpg');
    expect(afterFirst.steps.find((s) => s.id === compressStep.id)?.status).toBe(
      'RUNNING',
    );

    // Completing step 2 settles the job.
    await testBroker.natsService.publish(JOB_RESULTS_SUBJECT, {
      jobId: job.id,
      jobStepId: compressStep.id,
      status: 'complete',
      outputRef: '/tmp/compressed.jpg',
    } satisfies StepResultMessage);

    await waitUntil(async () => {
      const fetched = await jobsService.findOne(job.id);
      return fetched.status === 'COMPLETE';
    });
  });

  it('a failed result fails both the step and the job', async () => {
    const pipeline = await pipelinesService.create({
      name: 'single-step-fail',
      steps: [{ id: 'resize', processor: 'image.resize', params: {} }],
    });
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/fail-input.jpg',
    });

    await testBroker.natsService.publish(JOB_RESULTS_SUBJECT, {
      jobId: job.id,
      jobStepId: job.steps[0].id,
      status: 'failed',
      error: 'boom',
    } satisfies StepResultMessage);

    await waitUntil(async () => {
      const fetched = await jobsService.findOne(job.id);
      return fetched.status === 'FAILED';
    });

    const failed = await jobsService.findOne(job.id);
    expect(failed.steps[0].status).toBe('FAILED');
    expect(failed.steps[0].error).toBe('boom');
  });
});

// Redelivery / "no lost jobs" — deliberately isolated in its own describe
// block with its own NATS container and without JobResultConsumerService
// running, since a WorkQueue-retention stream allows only one consumer per
// (overlapping) filter subject: this test binds its own "jobs-results"
// durable directly (with a short AckWait) to control ack timing, which
// would conflict with the describe block above's running service if they
// shared a broker.
describe('JobResultConsumerService redelivery (integration, real Postgres + real NATS)', () => {
  let testDb: TestDb;
  let testBroker: TestBroker;
  let jobDispatchService: JobDispatchService;
  let jobsService: JobsService;
  let pipelinesService: PipelinesService;

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
  }, 120_000);

  afterAll(async () => {
    await testBroker.teardown();
    await testDb.teardown();
  });

  it('an unacked result is redelivered and processing it is safe to repeat', async () => {
    const pipeline = await pipelinesService.create({
      name: 'redelivery-target',
      steps: [{ id: 'resize', processor: 'image.resize', params: {} }],
    });
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/redelivery-input.jpg',
    });

    await testBroker.natsService.publish(JOB_RESULTS_SUBJECT, {
      jobId: job.id,
      jobStepId: job.steps[0].id,
      status: 'complete',
      outputRef: '/tmp/redelivered-output.jpg',
    } satisfies StepResultMessage);

    const consumer = await testBroker.natsService.durableConsumer(
      JOB_RESULTS_SUBJECT,
      JOB_RESULTS_DURABLE_NAME,
      { ackWaitMillis: 500 },
    );

    // First delivery: pull it, but simulate a crash by never acking.
    const first = await consumer.next({ expires: 5_000 });
    expect(first).not.toBeNull();
    expect(first!.redelivered).toBe(false);

    // Wait past AckWait so the server redelivers.
    const second = await consumer.next({ expires: 5_000 });
    expect(second).not.toBeNull();
    expect(second!.redelivered).toBe(true);

    // This time actually process it — safe even though the message
    // describes the same result as (an implicit retry of) the first,
    // unprocessed delivery.
    await handleStepResult(
      testDb.dbService,
      jobDispatchService,
      testBroker.natsService,
      second!,
    );

    const job1 = await jobsService.findOne(job.id);
    expect(job1.status).toBe('COMPLETE');
    expect(job1.steps[0].status).toBe('COMPLETE');
    expect(job1.steps[0].outputRef).toBe('/tmp/redelivered-output.jpg');

    // Processing a *third* (fully duplicate) delivery of an
    // already-applied result is also a safe no-op, not an error — the
    // concrete "no lost jobs" guarantee: redelivery never corrupts state
    // or crashes the consumer, whether or not the job already advanced.
    await testBroker.natsService.publish(JOB_RESULTS_SUBJECT, {
      jobId: job.id,
      jobStepId: job.steps[0].id,
      status: 'complete',
      outputRef: '/tmp/redelivered-output.jpg',
    } satisfies StepResultMessage);
    const third = await consumer.next({ expires: 5_000 });
    expect(third).not.toBeNull();
    await expect(
      handleStepResult(
        testDb.dbService,
        jobDispatchService,
        testBroker.natsService,
        third!,
      ),
    ).resolves.toBeUndefined();
  });
});
