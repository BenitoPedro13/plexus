import { NotFoundException } from '@nestjs/common';
import { setupTestDb, type TestDb } from '../../test/support/postgres-test-db';
import { DagValidationError } from './dag.validator';
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

  it('persists a valid linear chain in resolved (topological) order, dependsOn included', async () => {
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
    expect(created.definition.map((s) => s.dependsOn)).toEqual([
      [],
      ['resize'],
      ['compress'],
    ]);

    const fetched = await service.findOne(created.id);
    expect(fetched.definition.map((s) => s.id)).toEqual([
      'resize',
      'compress',
      'convert',
    ]);
  });

  it('resolves a fan-out DAG (one step, two independent dependents)', async () => {
    const created = await service.create({
      name: 'fan-out',
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

    expect(created.definition.map((s) => s.id)).toEqual(['root', 'a', 'b']);
    expect(created.definition.find((s) => s.id === 'a')?.dependsOn).toEqual([
      'root',
    ]);
    expect(created.definition.find((s) => s.id === 'b')?.dependsOn).toEqual([
      'root',
    ]);
  });

  it('treats a fully dependsOn-less definition as an implicit linear chain (recipe compatibility — the real Apply-to-Batch bug this task fixes)', async () => {
    const created = await service.create({
      name: 'implicit-chain',
      steps: [
        { id: 'a', processor: 'image.resize', params: {} },
        { id: 'b', processor: 'image.compress', params: {} },
        { id: 'c', processor: 'image.convert', params: { format: 'webp' } },
      ],
    });

    expect(created.definition.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(created.definition.map((s) => s.dependsOn)).toEqual([
      [],
      ['a'],
      ['b'],
    ]);
  });

  it('treats explicit dependsOn: [] as a genuinely independent root (opt out of implicit chaining)', async () => {
    const created = await service.create({
      name: 'independent-roots',
      steps: [
        { id: 'a', processor: 'image.resize', params: {}, dependsOn: [] },
        { id: 'b', processor: 'image.compress', params: {}, dependsOn: [] },
      ],
    });

    expect(created.definition.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(created.definition.map((s) => s.dependsOn)).toEqual([[], []]);
  });

  it('rejects a fan-in definition (a step depending on more than one step)', async () => {
    await expect(
      service.create({
        name: 'fan-in',
        steps: [
          { id: 'a', processor: 'image.resize', params: {} },
          { id: 'b', processor: 'image.compress', params: {} },
          {
            id: 'merge',
            processor: 'image.convert',
            params: { format: 'webp' },
            dependsOn: ['a', 'b'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      reason: 'FAN_IN_NOT_SUPPORTED',
    } satisfies Partial<DagValidationError>);
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
    } satisfies Partial<DagValidationError>);
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
    } satisfies Partial<DagValidationError>);
  });

  it('throws NotFoundException for an unknown pipeline id', async () => {
    await expect(
      service.findOne('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
