import { NotFoundException } from '@nestjs/common';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { LinearDagValidationError } from './linear-dag.validator';
import { PipelinesService } from './pipelines.service';

describe('PipelinesService (integration, real Postgres)', () => {
  let testDb: TestDb;
  let service: PipelinesService;

  beforeAll(async () => {
    testDb = await setupTestDb();
    service = new PipelinesService(testDb.dbService);
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  it('persists a valid linear chain in resolved order', async () => {
    const created = await service.create({
      name: 'web-optimize-image',
      steps: [
        {
          id: 'compress',
          processor: 'image.compress',
          params: { quality: 80 },
          dependsOn: ['resize'],
        },
        { id: 'resize', processor: 'image.resize', params: { width: 1600 } },
        {
          id: 'convert',
          processor: 'image.convert',
          params: { format: 'webp' },
          dependsOn: ['compress'],
        },
      ],
    });

    expect(created.definition.map((s) => s.id)).toEqual([
      'resize',
      'compress',
      'convert',
    ]);

    const fetched = await service.findOne(created.id);
    expect(fetched.definition.map((s) => s.id)).toEqual([
      'resize',
      'compress',
      'convert',
    ]);
  });

  it('rejects a branching definition (one step with two dependents)', async () => {
    await expect(
      service.create({
        name: 'branching',
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
            params: {},
            dependsOn: ['root'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      reason: 'BRANCHING_NOT_SUPPORTED',
    } satisfies Partial<LinearDagValidationError>);
  });

  it('rejects a definition with multiple roots', async () => {
    await expect(
      service.create({
        name: 'multi-root',
        steps: [
          { id: 'a', processor: 'image.resize', params: {} },
          { id: 'b', processor: 'image.compress', params: {} },
        ],
      }),
    ).rejects.toMatchObject({
      reason: 'MULTIPLE_ROOTS',
    } satisfies Partial<LinearDagValidationError>);
  });

  it('rejects a cyclic definition', async () => {
    await expect(
      service.create({
        name: 'cyclic',
        steps: [
          { id: 'a', processor: 'image.resize', params: {}, dependsOn: ['b'] },
          {
            id: 'b',
            processor: 'image.compress',
            params: {},
            dependsOn: ['a'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      reason: 'CYCLE_DETECTED',
    } satisfies Partial<LinearDagValidationError>);
  });

  it('rejects a definition that depends on an unknown step', async () => {
    await expect(
      service.create({
        name: 'unknown-dep',
        steps: [
          {
            id: 'a',
            processor: 'image.resize',
            params: {},
            dependsOn: ['does-not-exist'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      reason: 'MISSING_DEPENDENCY',
    } satisfies Partial<LinearDagValidationError>);
  });

  it('throws NotFoundException for an unknown pipeline id', async () => {
    await expect(
      service.findOne('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
