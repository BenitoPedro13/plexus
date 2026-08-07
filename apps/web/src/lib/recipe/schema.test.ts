import { describe, expect, test } from 'vitest'
import {
  adjustColorParamsSchema,
  adjustLightParamsSchema,
  blackAndWhiteParamsSchema,
  compressParamsSchema,
  convertParamsSchema,
  recipeSchema,
  resizeParamsSchema,
  sharpenParamsSchema,
} from './schema'

describe('recipeSchema', () => {
  test('round-trips a recipe with all seven processor types', () => {
    const recipe = {
      name: 'web-optimized',
      steps: [
        {
          id: 'step-1',
          processor: 'image.resize' as const,
          params: { width: 1200, height: 800, fit: 'inside' as const },
        },
        {
          id: 'step-2',
          processor: 'image.compress' as const,
          params: { quality: 70 },
        },
        {
          id: 'step-3',
          processor: 'image.convert' as const,
          params: { format: 'webp' as const, quality: 80 },
        },
        {
          id: 'step-4',
          processor: 'image.adjustLight' as const,
          params: { exposure: 0.5, brightness: 0, contrast: 0.2, blackPoint: 0 },
        },
        {
          id: 'step-5',
          processor: 'image.adjustColor' as const,
          params: { saturation: 0.3 },
        },
        {
          id: 'step-6',
          processor: 'image.blackAndWhite' as const,
          params: { intensity: 1, neutrals: 0, tone: -0.2 },
        },
        {
          id: 'step-7',
          processor: 'image.sharpen' as const,
          params: { intensity: 0.4 },
        },
      ],
    }

    const parsed = recipeSchema.parse(recipe)
    expect(parsed).toEqual(recipe)
  })

  test('accepts an empty steps array', () => {
    expect(recipeSchema.parse({ steps: [] })).toEqual({ steps: [] })
  })

  test('rejects an unknown processor value', () => {
    expect(() =>
      recipeSchema.parse({
        steps: [{ id: 's1', processor: 'image.unknown', params: {} }],
      }),
    ).toThrow()
  })
})

describe('resizeParamsSchema', () => {
  test('requires width', () => {
    expect(() =>
      resizeParamsSchema.parse({ height: 100, fit: 'inside' }),
    ).toThrow()
  })

  test('requires height', () => {
    expect(() =>
      resizeParamsSchema.parse({ width: 100, fit: 'inside' }),
    ).toThrow()
  })

  test('defaults fit to "inside" when omitted', () => {
    expect(resizeParamsSchema.parse({ width: 100, height: 200 })).toEqual({
      width: 100,
      height: 200,
      fit: 'inside',
    })
  })
})

describe('convertParamsSchema', () => {
  test('requires format', () => {
    expect(() => convertParamsSchema.parse({ quality: 50 })).toThrow()
  })

  test('defaults quality to 85 when omitted, matching Go defaultQuality', () => {
    expect(convertParamsSchema.parse({ format: 'jpeg' })).toEqual({
      format: 'jpeg',
      quality: 85,
    })
  })

  test.each([0, 101])('rejects out-of-range quality %d', (quality) => {
    expect(() =>
      convertParamsSchema.parse({ format: 'jpeg', quality }),
    ).toThrow()
  })
})

describe('compressParamsSchema', () => {
  test('requires quality', () => {
    expect(() => compressParamsSchema.parse({})).toThrow()
  })

  test.each([0, 101])('rejects out-of-range quality %d', (quality) => {
    expect(() => compressParamsSchema.parse({ quality })).toThrow()
  })
})

describe('adjustLightParamsSchema', () => {
  test('accepts all four P0 params at range boundaries', () => {
    expect(
      adjustLightParamsSchema.parse({
        exposure: -3.0,
        brightness: -1.0,
        contrast: -1.0,
        blackPoint: 0.0,
      }),
    ).toEqual({ exposure: -3.0, brightness: -1.0, contrast: -1.0, blackPoint: 0.0 })
    expect(
      adjustLightParamsSchema.parse({
        exposure: 3.0,
        brightness: 1.0,
        contrast: 1.0,
        blackPoint: 1.0,
      }),
    ).toEqual({ exposure: 3.0, brightness: 1.0, contrast: 1.0, blackPoint: 1.0 })
  })

  test('requires all four params', () => {
    expect(() =>
      adjustLightParamsSchema.parse({ exposure: 0, brightness: 0, contrast: 0 }),
    ).toThrow()
  })

  test.each([-3.1, 3.1])('rejects out-of-range exposure %d', (exposure) => {
    expect(() =>
      adjustLightParamsSchema.parse({
        exposure,
        brightness: 0,
        contrast: 0,
        blackPoint: 0,
      }),
    ).toThrow()
  })

  test.each([-0.1, 1.1])('rejects out-of-range blackPoint %d', (blackPoint) => {
    expect(() =>
      adjustLightParamsSchema.parse({
        exposure: 0,
        brightness: 0,
        contrast: 0,
        blackPoint,
      }),
    ).toThrow()
  })
})

describe('adjustColorParamsSchema', () => {
  test.each([-1.0, 1.0])('accepts saturation at boundary %d', (saturation) => {
    expect(adjustColorParamsSchema.parse({ saturation })).toEqual({ saturation })
  })

  test('requires saturation', () => {
    expect(() => adjustColorParamsSchema.parse({})).toThrow()
  })

  test.each([-1.1, 1.1])('rejects out-of-range saturation %d', (saturation) => {
    expect(() => adjustColorParamsSchema.parse({ saturation })).toThrow()
  })
})

describe('blackAndWhiteParamsSchema', () => {
  test('accepts all three P0 params at range boundaries', () => {
    expect(
      blackAndWhiteParamsSchema.parse({ intensity: 0.0, neutrals: -1.0, tone: -1.0 }),
    ).toEqual({ intensity: 0.0, neutrals: -1.0, tone: -1.0 })
    expect(
      blackAndWhiteParamsSchema.parse({ intensity: 1.0, neutrals: 1.0, tone: 1.0 }),
    ).toEqual({ intensity: 1.0, neutrals: 1.0, tone: 1.0 })
  })

  test('requires all three params', () => {
    expect(() =>
      blackAndWhiteParamsSchema.parse({ intensity: 0.5, neutrals: 0 }),
    ).toThrow()
  })

  test.each([-0.1, 1.1])('rejects out-of-range intensity %d', (intensity) => {
    expect(() =>
      blackAndWhiteParamsSchema.parse({ intensity, neutrals: 0, tone: 0 }),
    ).toThrow()
  })
})

describe('sharpenParamsSchema', () => {
  test.each([0.0, 1.0])('accepts intensity at boundary %d', (intensity) => {
    expect(sharpenParamsSchema.parse({ intensity })).toEqual({ intensity })
  })

  test('requires intensity', () => {
    expect(() => sharpenParamsSchema.parse({})).toThrow()
  })

  test.each([-0.1, 1.1])('rejects out-of-range intensity %d', (intensity) => {
    expect(() => sharpenParamsSchema.parse({ intensity })).toThrow()
  })
})
