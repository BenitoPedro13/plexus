import { NotFoundException } from '@nestjs/common';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { jobs, jobSteps, pipelines } from '../db/schema';
import { IllegalTransitionError } from './job-status';
import {
  transitionJobStatus,
  transitionJobStepStatus,
} from './job-transitions';

// Pure state-machine coverage against real Postgres, deliberately without
// NATS in the picture — same reasoning TASK-job-state-machine.md used to
// keep slice 1 reviewable on its own. JobDispatchService/JobsService.create()
// now trigger these same functions as a side effect of dispatch, which is
// covered (with real NATS) in job-dispatch.integration-spec.ts instead.
describe('job-transitions (integration, real Postgres)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  async function insertJobWithStep() {
    const [pipeline] = await testDb.dbService.db
      .insert(pipelines)
      .values({
        name: 'noop',
        definition: [
          {
            id: 'resize',
            processor: 'image.resize',
            params: {},
            dependsOn: [],
          },
        ],
      })
      .returning();

    const [job] = await testDb.dbService.db
      .insert(jobs)
      .values({ pipelineId: pipeline.id, inputRef: '/tmp/in.jpg' })
      .returning();

    const [step] = await testDb.dbService.db
      .insert(jobSteps)
      .values({
        jobId: job.id,
        stepId: 'resize',
        processor: 'image.resize',
        params: {},
        dependsOn: [],
        order: 0,
      })
      .returning();

    return { job, step };
  }

  it('accepts every legal job transition and rejects illegal ones', async () => {
    const { job } = await insertJobWithStep();
    const db = testDb.dbService.db;

    await expect(
      transitionJobStatus(db, job.id, 'COMPLETE'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const running = await transitionJobStatus(db, job.id, 'RUNNING');
    expect(running.status).toBe('RUNNING');

    const partial = await transitionJobStatus(db, job.id, 'PARTIAL');
    expect(partial.status).toBe('PARTIAL');

    // PARTIAL is a genuinely terminal settlement
    // (docs/tasks/TASK-branching-parallel-dags.md) — no legal transition out
    // of it, including back to RUNNING.
    await expect(
      transitionJobStatus(db, job.id, 'RUNNING'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('accepts RUNNING -> COMPLETE and rejects transitions out of a terminal job', async () => {
    const { job } = await insertJobWithStep();
    const db = testDb.dbService.db;

    await transitionJobStatus(db, job.id, 'RUNNING');
    const complete = await transitionJobStatus(db, job.id, 'COMPLETE');
    expect(complete.status).toBe('COMPLETE');

    await expect(
      transitionJobStatus(db, job.id, 'RUNNING'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('accepts every legal job-step transition and rejects illegal ones, stamping timestamps and outputRef', async () => {
    const { step } = await insertJobWithStep();
    const db = testDb.dbService.db;

    await expect(
      transitionJobStepStatus(db, step.id, 'COMPLETE'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const running = await transitionJobStepStatus(db, step.id, 'RUNNING');
    expect(running.status).toBe('RUNNING');
    expect(running.startedAt).not.toBeNull();

    const complete = await transitionJobStepStatus(db, step.id, 'COMPLETE', {
      outputRef: '/tmp/out.jpg',
    });
    expect(complete.status).toBe('COMPLETE');
    expect(complete.completedAt).not.toBeNull();
    expect(complete.outputRef).toBe('/tmp/out.jpg');

    await expect(
      transitionJobStepStatus(db, step.id, 'RUNNING'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('accepts PENDING -> SKIPPED (cascading skip) and rejects transitions out of it', async () => {
    const { step } = await insertJobWithStep();
    const db = testDb.dbService.db;

    const skipped = await transitionJobStepStatus(db, step.id, 'SKIPPED', {
      error: 'Skipped: ancestor step "resize" failed',
    });
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.error).toBe('Skipped: ancestor step "resize" failed');

    await expect(
      transitionJobStepStatus(db, step.id, 'SKIPPED'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(
      transitionJobStepStatus(db, step.id, 'RUNNING'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('throws NotFoundException transitioning an unknown job or step', async () => {
    const db = testDb.dbService.db;

    await expect(
      transitionJobStatus(
        db,
        '00000000-0000-0000-0000-000000000000',
        'RUNNING',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      transitionJobStepStatus(
        db,
        '00000000-0000-0000-0000-000000000000',
        'RUNNING',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
