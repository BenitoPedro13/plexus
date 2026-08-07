import { describe, expect, test } from 'vitest'
import {
  compressParamsSchema,
  convertParamsSchema,
  recipeSchema,
  resizeParamsSchema,
} from './schema'

describe('recipeSchema', () => {
  test('round-trips a recipe with all three processor types', () => {
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
