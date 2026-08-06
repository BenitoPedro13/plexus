import { NotFoundException } from '@nestjs/common';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { IllegalTransitionError } from './job-status';
import { JobsService } from './jobs.service';
import { PipelinesService } from '../pipelines/pipelines.service';

describe('JobsService (integration, real Postgres)', () => {
  let testDb: TestDb;
  let jobsService: JobsService;
  let pipelinesService: PipelinesService;

  beforeAll(async () => {
    testDb = await setupTestDb();
    jobsService = new JobsService(testDb.dbService);
    pipelinesService = new PipelinesService(testDb.dbService);
  }, 120_000);

  afterAll(async () => {
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

  it('materializes one PENDING step per pipeline step, in order, and the job starts QUEUED', async () => {
    const pipeline = await createTwoStepPipeline();

    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/input.jpg',
    });

    expect(job.status).toBe('QUEUED');
    expect(job.steps).toHaveLength(2);
    expect(job.steps.map((s) => [s.stepId, s.order, s.status])).toEqual([
      ['resize', 0, 'PENDING'],
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

  it('accepts every legal job transition and rejects illegal ones', async () => {
    const pipeline = await createTwoStepPipeline();
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/a.jpg',
    });

    // QUEUED -> COMPLETE directly is illegal.
    await expect(
      jobsService.transitionJob(job.id, 'COMPLETE'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const running = await jobsService.transitionJob(job.id, 'RUNNING');
    expect(running.status).toBe('RUNNING');

    const partial = await jobsService.transitionJob(job.id, 'PARTIAL');
    expect(partial.status).toBe('PARTIAL');

    const runningAgain = await jobsService.transitionJob(job.id, 'RUNNING');
    expect(runningAgain.status).toBe('RUNNING');

    const complete = await jobsService.transitionJob(job.id, 'COMPLETE');
    expect(complete.status).toBe('COMPLETE');

    // COMPLETE is terminal.
    await expect(
      jobsService.transitionJob(job.id, 'RUNNING'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('accepts every legal job-step transition and rejects illegal ones, stamping timestamps', async () => {
    const pipeline = await createTwoStepPipeline();
    const job = await jobsService.create({
      pipelineId: pipeline.id,
      inputRef: '/tmp/b.jpg',
    });
    const [firstStep] = job.steps;

    // PENDING -> COMPLETE directly is illegal.
    await expect(
      jobsService.transitionStep(firstStep.id, 'COMPLETE'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const running = await jobsService.transitionStep(firstStep.id, 'RUNNING');
    expect(running.status).toBe('RUNNING');
    expect(running.startedAt).not.toBeNull();

    const complete = await jobsService.transitionStep(running.id, 'COMPLETE');
    expect(complete.status).toBe('COMPLETE');
    expect(complete.completedAt).not.toBeNull();

    // COMPLETE is terminal.
    await expect(
      jobsService.transitionStep(firstStep.id, 'RUNNING'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
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
