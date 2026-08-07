import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BUILTIN_PROCESSORS, CreatePipelineDto } from './create-pipeline.dto';

// Regression coverage for the real, confirmed bug TASK-recipe-packages-
// extraction.md fixed: BUILTIN_PROCESSORS used to hand-list only the Phase 1
// image processors, so submitting an editor-built recipe using crop or any
// composite-slider step (adjustLight/adjustColor/blackAndWhite/sharpen) to
// POST /pipelines was rejected outright by @IsIn(BUILTIN_PROCESSORS) — the
// literal blocker for "Apply to Batch." Plain class-validator/class-
// transformer against the DTO directly, no DB/queue involved, so the
// codebase's no-mocking rule (scoped to DB/queue) doesn't apply here.
describe('CreatePipelineDto', () => {
  function buildDto(steps: Array<Record<string, unknown>>) {
    return plainToInstance(CreatePipelineDto, { name: 'test pipeline', steps });
  }

  it('lists every image.* processor id, not a stale Phase 1 subset', () => {
    expect(BUILTIN_PROCESSORS).toEqual(
      expect.arrayContaining([
        'image.resize',
        'image.convert',
        'image.compress',
        'image.crop',
        'image.adjustLight',
        'image.adjustColor',
        'image.blackAndWhite',
        'image.sharpen',
        'video.transcode',
        'video.compress',
        'audio.extract',
        'audio.convert',
      ]),
    );
  });

  it('accepts an image.crop step with valid params', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'image.crop',
        params: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      },
    ]);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts an image.adjustLight step with only the required params', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'image.adjustLight',
        params: { exposure: 0.5, brightness: 0, contrast: 0, blackPoint: 0 },
      },
    ]);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an image.crop step missing a required param', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'image.crop',
        params: { x: 0.1, y: 0.1, width: 0.5 },
      },
    ]);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const paramsError = errors[0].children?.[0]?.children?.find(
      (e) => e.property === 'params',
    );
    expect(paramsError?.constraints?.validateProcessorParams).toContain(
      'params invalid for "image.crop"',
    );
  });

  it('rejects an image.resize step with an out-of-range param', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'image.resize',
        params: { width: -10, height: 100, fit: 'inside' },
      },
    ]);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a video.transcode step with valid params', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'video.transcode',
        params: { format: 'mp4', quality: 75 },
      },
    ]);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a video.transcode step with params that no longer fall back to a plain-object check (TASK-quick-actions-screen.md)', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'video.transcode',
        params: { codec: 'h264', bitrate: 4_000_000 },
      },
    ]);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const paramsError = errors[0].children?.[0]?.children?.find(
      (e) => e.property === 'params',
    );
    expect(paramsError?.constraints?.validateProcessorParams).toContain(
      'params invalid for "video.transcode"',
    );
  });

  it('accepts an audio.convert step with valid params', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'audio.convert',
        params: { format: 'wav', bitrate: 128 },
      },
    ]);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('still rejects an unknown processor id', async () => {
    const dto = buildDto([
      {
        id: 'step-1',
        processor: 'image.doesNotExist',
        params: {},
      },
    ]);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
