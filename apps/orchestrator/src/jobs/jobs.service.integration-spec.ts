import { NotFoundException } from '@nestjs/common';
import {
  setupTestBroker,
  type TestBroker,
} from '../../test/support/nats-test-broker';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { PipelinesService } from '../pipelines/pipelines.service';
import { JobDispatchService } from './job-dispatch.service';
import { JobsService } from './jobs.service';

// create()'s dispatch side effect (see job-dispatch.service.ts) means
// JobsService now depends on NATS transitively, so this suite runs against
// both real Postgres and real NATS — no mocking either, per CLAUDE.md.
// The state-machine transition matrix itself is covered NATS-free in
// job-transitions.integration-spec.ts.
describe('JobsService (integration, real Postgres + real NATS)', () => {
  let testDb: TestDb;
  let testBroker: TestBroker;
  let jobsService: JobsService;
  let pipelinesService: PipelinesService;

  beforeAll(async () => {
    testDb = await setupTestDb();
    testBroker = await setupTestBroker();
    const jobDispatchService = new JobDispatchService(
      testDb.dbService,
      testBroker.natsService,
    );
    jobsService = new JobsService(testDb.dbService, jobDispatchService);
    pipelinesService = new PipelinesService(testDb.dbService);
  }, 120_000);

  afterAll(async () => {
    await testBroker.teardown();
    await testDb.teardown();
  });

  async function createTwoStepPipeline() {
    return pipelinesService.create({
      name: 'resize-then-compress',
      steps: [
        { id: 'resize', processor: 'image.resize', params: { width: 800 } },
        {
          id: 'compress',
          processor: 'image.compress',
          params: { quality: 75 },
          dependsOn: ['resize'],
        },
      ],
    });
  }

  it('materializes one step per pipeline step and immediately dispatches the first', async () => {
    const pipeline = await createTwoStepPipeline();

    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/input.jpg',
    });

    // create() dispatches the first step synchronously (see
    // JobDispatchService), so by the time it returns the job is already
    // RUNNING with its first step RUNNING, not QUEUED/PENDING.
    expect(job.status).toBe('RUNNING');
    expect(job.steps).toHaveLength(2);
    expect(job.steps.map((s) => [s.stepId, s.order, s.status])).toEqual([
      ['resize', 0, 'RUNNING'],
      ['compress', 1, 'PENDING'],
    ]);

    const fetched = await jobsService.findOne(job.id);
    expect(fetched.steps.map((s) => s.stepId)).toEqual(['resize', 'compress']);
  });

  it('throws NotFoundException when creating a job against an unknown pipeline', async () => {
    await expect(
      jobsService.create({
        pipelineId: '00000000-0000-0000-0000-000000000000',
        inputRef: '/tmp/input.jpg',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('transitionJob/transitionStep delegate to the shared transition rules', async () => {
    const pipeline = await createTwoStepPipeline();
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/c.jpg',
    });
    const [firstStep] = job.steps;

    const completedStep = await jobsService.transitionStep(
      firstStep.id,
      'COMPLETE',
    );
    expect(completedStep.status).toBe('COMPLETE');

    const partialJob = await jobsService.transitionJob(job.id, 'PARTIAL');
    expect(partialJob.status).toBe('PARTIAL');
  });

  it('throws NotFoundException transitioning an unknown job or step', async () => {
    await expect(
      jobsService.transitionJob(
        '00000000-0000-0000-0000-000000000000',
        'RUNNING',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      jobsService.transitionStep(
        '00000000-0000-0000-0000-000000000000',
        'RUNNING',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
