import { describe, expect, test } from 'vitest'
import {
  adjustColorParamsSchema,
  adjustLightParamsSchema,
  blackAndWhiteParamsSchema,
  compressParamsSchema,
  convertParamsSchema,
  cropParamsSchema,
  recipeSchema,
  resizeParamsSchema,
  sharpenParamsSchema,
} from './schema'

describe('recipeSchema', () => {
  test('round-trips a recipe with all eight processor types', () => {
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
        {
          id: 'step-8',
          processor: 'image.crop' as const,
          params: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        },
      ],
    }

    const parsed = recipeSchema.parse(recipe)
    // step-4 (image.adjustLight) omits highlights/shadows on input -- they
    // default to 0 on parse (TASK-highlights-shadows-tonelut.md); step-5
    // (image.adjustColor) omits castStrength -- it defaults to 0 on parse
    // (TASK-adjust-color-cast.md); step-6 (image.blackAndWhite) omits grain --
    // it defaults to 0 on parse (TASK-black-and-white-grain.md) -- so the
    // round-trip isn't byte-identical to the input for those three steps.
    expect(parsed).toEqual({
      ...recipe,
      steps: recipe.steps.map((step) => {
        if (step.id === 'step-4') {
          return { ...step, params: { ...step.params, highlights: 0, shadows: 0 } }
        }
        if (step.id === 'step-5') {
          return { ...step, params: { ...step.params, castStrength: 0 } }
        }
        if (step.id === 'step-6') {
          return { ...step, params: { ...step.params, grain: 0 } }
        }
        return step
      }),
    })
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
  test('accepts all four required P0 params at range boundaries, defaulting highlights/shadows to 0', () => {
    expect(
      adjustLightParamsSchema.parse({
        exposure: -3.0,
        brightness: -1.0,
        contrast: -1.0,
        blackPoint: 0.0,
      }),
    ).toEqual({
      exposure: -3.0,
      brightness: -1.0,
      contrast: -1.0,
      blackPoint: 0.0,
      highlights: 0.0,
      shadows: 0.0,
    })
    expect(
      adjustLightParamsSchema.parse({
        exposure: 3.0,
        brightness: 1.0,
        contrast: 1.0,
        blackPoint: 1.0,
      }),
    ).toEqual({
      exposure: 3.0,
      brightness: 1.0,
      contrast: 1.0,
      blackPoint: 1.0,
      highlights: 0.0,
      shadows: 0.0,
    })
  })

  test('requires all four original params', () => {
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

  test.each([-1.0, 1.0])('accepts highlights at boundary %d', (highlights) => {
    expect(() =>
      adjustLightParamsSchema.parse({
        exposure: 0,
        brightness: 0,
        contrast: 0,
        blackPoint: 0,
        highlights,
      }),
    ).not.toThrow()
  })

  test.each([-1.1, 1.1])('rejects out-of-range highlights %d', (highlights) => {
    expect(() =>
      adjustLightParamsSchema.parse({
        exposure: 0,
        brightness: 0,
        contrast: 0,
        blackPoint: 0,
        highlights,
      }),
    ).toThrow()
  })

  test.each([-1.0, 1.0])('accepts shadows at boundary %d', (shadows) => {
    expect(() =>
      adjustLightParamsSchema.parse({
        exposure: 0,
        brightness: 0,
        contrast: 0,
        blackPoint: 0,
        shadows,
      }),
    ).not.toThrow()
  })

  test.each([-1.1, 1.1])('rejects out-of-range shadows %d', (shadows) => {
    expect(() =>
      adjustLightParamsSchema.parse({
        exposure: 0,
        brightness: 0,
        contrast: 0,
        blackPoint: 0,
        shadows,
      }),
    ).toThrow()
  })
})

describe('adjustColorParamsSchema', () => {
  test.each([-1.0, 1.0])('accepts saturation at boundary %d', (saturation) => {
    expect(adjustColorParamsSchema.parse({ saturation })).toEqual({ saturation, castStrength: 0 })
  })

  test('requires saturation', () => {
    expect(() => adjustColorParamsSchema.parse({})).toThrow()
  })

  test.each([-1.1, 1.1])('rejects out-of-range saturation %d', (saturation) => {
    expect(() => adjustColorParamsSchema.parse({ saturation })).toThrow()
  })

  test('castStrength defaults to 0 when omitted', () => {
    expect(adjustColorParamsSchema.parse({ saturation: 0 })).toEqual({
      saturation: 0,
      castStrength: 0,
    })
  })

  test.each([0.0, 1.0])('accepts castStrength at boundary %d', (castStrength) => {
    expect(adjustColorParamsSchema.parse({ saturation: 0, castStrength })).toEqual({
      saturation: 0,
      castStrength,
    })
  })

  test.each([-0.1, 1.1])('rejects out-of-range castStrength %d', (castStrength) => {
    expect(() => adjustColorParamsSchema.parse({ saturation: 0, castStrength })).toThrow()
  })
})

describe('blackAndWhiteParamsSchema', () => {
  test('accepts all three required P0 params at range boundaries, defaulting grain to 0', () => {
    expect(
      blackAndWhiteParamsSchema.parse({ intensity: 0.0, neutrals: -1.0, tone: -1.0 }),
    ).toEqual({ intensity: 0.0, neutrals: -1.0, tone: -1.0, grain: 0 })
    expect(
      blackAndWhiteParamsSchema.parse({ intensity: 1.0, neutrals: 1.0, tone: 1.0 }),
    ).toEqual({ intensity: 1.0, neutrals: 1.0, tone: 1.0, grain: 0 })
  })

  test('requires all three required params', () => {
    expect(() =>
      blackAndWhiteParamsSchema.parse({ intensity: 0.5, neutrals: 0 }),
    ).toThrow()
  })

  test.each([-0.1, 1.1])('rejects out-of-range intensity %d', (intensity) => {
    expect(() =>
      blackAndWhiteParamsSchema.parse({ intensity, neutrals: 0, tone: 0 }),
    ).toThrow()
  })

  test('grain defaults to 0 when omitted', () => {
    expect(
      blackAndWhiteParamsSchema.parse({ intensity: 0, neutrals: 0, tone: 0 }),
    ).toEqual({ intensity: 0, neutrals: 0, tone: 0, grain: 0 })
  })

  test.each([0.0, 1.0])('accepts grain at boundary %d', (grain) => {
    expect(
      blackAndWhiteParamsSchema.parse({ intensity: 0, neutrals: 0, tone: 0, grain }),
    ).toEqual({ intensity: 0, neutrals: 0, tone: 0, grain })
  })

  test.each([-0.1, 1.1])('rejects out-of-range grain %d', (grain) => {
    expect(() =>
      blackAndWhiteParamsSchema.parse({ intensity: 0, neutrals: 0, tone: 0, grain }),
    ).toThrow()
  })
})

describe('cropParamsSchema', () => {
  test('accepts a rect within bounds', () => {
    expect(cropParamsSchema.parse({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.6,
    })
  })

  test('accepts a full-frame rect', () => {
    expect(cropParamsSchema.parse({ x: 0, y: 0, width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
  })

  test.each(['x', 'y', 'width', 'height'] as const)('requires %s', (key) => {
    const params: Record<string, number> = { x: 0, y: 0, width: 0.5, height: 0.5 }
    delete params[key]
    expect(() => cropParamsSchema.parse(params)).toThrow()
  })

  test.each([0.0, -0.1])('rejects non-positive width %d', (width) => {
    expect(() => cropParamsSchema.parse({ x: 0, y: 0, width, height: 0.5 })).toThrow()
  })

  test.each([0.0, -0.1])('rejects non-positive height %d', (height) => {
    expect(() => cropParamsSchema.parse({ x: 0, y: 0, width: 0.5, height })).toThrow()
  })

  test('rejects x + width exceeding 1.0', () => {
    expect(() => cropParamsSchema.parse({ x: 0.6, y: 0, width: 0.6, height: 0.5 })).toThrow()
  })

  test('rejects y + height exceeding 1.0', () => {
    expect(() => cropParamsSchema.parse({ x: 0, y: 0.6, width: 0.5, height: 0.6 })).toThrow()
  })

  test.each([-0.1, 1.1])('rejects out-of-range x %d', (x) => {
    expect(() => cropParamsSchema.parse({ x, y: 0, width: 0.1, height: 0.1 })).toThrow()
  })

  test.each([-0.1, 1.1])('rejects out-of-range y %d', (y) => {
    expect(() => cropParamsSchema.parse({ x: 0, y, width: 0.1, height: 0.1 })).toThrow()
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
