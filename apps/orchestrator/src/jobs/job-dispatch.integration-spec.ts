import type { Consumer } from '@nats-io/jetstream';
import {
  setupTestBroker,
  type TestBroker,
} from '../../test/support/nats-test-broker';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { JOB_DISPATCH_SUBJECT } from '../nats/nats.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import type { StepDispatchMessage } from './dispatch-message';
import { JobDispatchService } from './job-dispatch.service';
import { transitionJobStepStatus } from './job-transitions';
import { JobsService } from './jobs.service';

describe('JobDispatchService (integration, real Postgres + real NATS)', () => {
  let testDb: TestDb;
  let testBroker: TestBroker;
  let jobDispatchService: JobDispatchService;
  let jobsService: JobsService;
  let pipelinesService: PipelinesService;
  // A WorkQueue-retention stream allows only one consumer per (overlapping)
  // filter subject, so both tests below share this one durable consumer
  // rather than each creating their own on the same JOB_DISPATCH_SUBJECT.
  let consumer: Consumer;

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
    consumer = await testBroker.natsService.durableConsumer(
      JOB_DISPATCH_SUBJECT,
      'test-dispatch-consumer',
    );
  }, 120_000);

  afterAll(async () => {
    await testBroker.teardown();
    await testDb.teardown();
  });

  it('creating a job publishes a dispatch message for its first step', async () => {
    const pipeline = await pipelinesService.create({
      name: 'resize-only',
      steps: [
        { id: 'resize', processor: 'image.resize', params: { width: 640 } },
      ],
    });

    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/dispatch-input.jpg',
    });

    expect(job.status).toBe('RUNNING');
    expect(job.steps[0].status).toBe('RUNNING');

    const msg = await consumer.next({ expires: 5_000 });
    expect(msg).not.toBeNull();

    const payload = msg!.json<StepDispatchMessage>();
    expect(payload).toEqual({
      jobId: job.id,
      jobStepId: job.steps[0].id,
      stepId: 'resize',
      processor: 'image.resize',
      params: { width: 640 },
      inputRef: '/tmp/dispatch-input.jpg',
      order: 0,
    });
    msg!.ack();
  });

  it("chains the next step's inputRef from the previous step's outputRef", async () => {
    const pipeline = await pipelinesService.create({
      name: 'resize-then-compress-chain',
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
      inputRef: '/tmp/chain-input.jpg',
    });

    // Drain the first step's dispatch message (already covered above).
    const first = await consumer.next({ expires: 5_000 });
    first!.ack();

    const [resizeStep] = job.steps;
    await transitionJobStepStatus(
      testDb.dbService.db,
      resizeStep.id,
      'COMPLETE',
      {
        outputRef: '/tmp/resized.jpg',
      },
    );
    await jobDispatchService.dispatchNext(job.id);

    const second = await consumer.next({ expires: 5_000 });
    expect(second).not.toBeNull();
    const payload = second!.json<StepDispatchMessage>();
    expect(payload.stepId).toBe('compress');
    expect(payload.inputRef).toBe('/tmp/resized.jpg');
    second!.ack();
  });

  it('dispatches every ready step in the same call (fan-out — TASK-branching-parallel-dags.md)', async () => {
    const pipeline = await pipelinesService.create({
      name: 'fan-out-dispatch',
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
      inputRef: '/tmp/fan-out-input.jpg',
    });

    const rootMsg = await consumer.next({ expires: 5_000 });
    rootMsg!.ack();

    const [rootStep] = job.steps;
    await transitionJobStepStatus(
      testDb.dbService.db,
      rootStep.id,
      'COMPLETE',
      {
        outputRef: '/tmp/root-output.jpg',
      },
    );
    await jobDispatchService.dispatchNext(job.id);

    const first = await consumer.next({ expires: 5_000 });
    const second = await consumer.next({ expires: 5_000 });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const payloads = [first!, second!].map((msg) =>
      msg.json<StepDispatchMessage>(),
    );
    expect(payloads.map((p) => p.stepId).sort()).toEqual(['a', 'b']);
    for (const payload of payloads) {
      expect(payload.inputRef).toBe('/tmp/root-output.jpg');
    }
    first!.ack();
    second!.ack();
  });
});
