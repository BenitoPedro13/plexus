import { describe, expect, it } from 'vitest'
import type { Recipe } from '@/lib/recipe/schema'
import {
  applyAdjustColor,
  applyAdjustLight,
  applyBlackAndWhite,
  applyUnsharpMask,
  collectOrderedAdjustmentSteps,
  gaussianKernel1D,
  type RGBA,
} from './color-math'

const GRAY: RGBA = { r: 0.5, g: 0.5, b: 0.5, a: 1 }
const RED: RGBA = { r: 0.8, g: 0.2, b: 0.2, a: 1 }

describe('applyAdjustLight', () => {
  it('identity params leave a pixel unchanged', () => {
    const result = applyAdjustLight(GRAY, { exposure: 0, brightness: 0, contrast: 0, blackPoint: 0 })
    expect(result.r).toBeCloseTo(0.5)
    expect(result.g).toBeCloseTo(0.5)
    expect(result.b).toBeCloseTo(0.5)
    expect(result.a).toBe(1)
  })

  it('positive exposure strictly brightens', () => {
    const result = applyAdjustLight(GRAY, { exposure: 1, brightness: 0, contrast: 0, blackPoint: 0 })
    expect(result.r).toBeGreaterThan(GRAY.r)
  })

  it('blackPoint=1.0 clips to black without NaN/Infinity (mirrors the Go divide-by-zero guard)', () => {
    const result = applyAdjustLight(GRAY, { exposure: 0, brightness: 0, contrast: 0, blackPoint: 1.0 })
    expect(Number.isFinite(result.r)).toBe(true)
    expect(result.r).toBe(0)
  })

  it('leaves alpha untouched regardless of params (D-20: unlike Go, which mutates all bands)', () => {
    const translucent: RGBA = { r: 0.5, g: 0.5, b: 0.5, a: 0.3 }
    const result = applyAdjustLight(translucent, { exposure: 2, brightness: -0.5, contrast: 0.8, blackPoint: 0.5 })
    expect(result.a).toBe(0.3)
  })
})

describe('applyAdjustColor', () => {
  it('saturation=0 is identity within float tolerance', () => {
    const result = applyAdjustColor(RED, { saturation: 0 })
    expect(result.r).toBeCloseTo(RED.r, 2)
    expect(result.g).toBeCloseTo(RED.g, 2)
    expect(result.b).toBeCloseTo(RED.b, 2)
  })

  it('saturation=-1 fully desaturates to R=G=B', () => {
    const result = applyAdjustColor(RED, { saturation: -1 })
    expect(result.r).toBeCloseTo(result.g, 2)
    expect(result.g).toBeCloseTo(result.b, 2)
  })

  it('positive saturation increases channel spread on a non-gray pixel', () => {
    const baseline = applyAdjustColor(RED, { saturation: 0 })
    const boosted = applyAdjustColor(RED, { saturation: 0.5 })
    const spread = (p: RGBA) => Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b)
    expect(spread(boosted)).toBeGreaterThan(spread(baseline))
  })

  it('preserves alpha', () => {
    const result = applyAdjustColor({ ...RED, a: 0.4 }, { saturation: 0.5 })
    expect(result.a).toBe(0.4)
  })

  it('a perfectly achromatic pixel stays finite and unchanged at saturation>0 (TASK-adjust-color-atan2-zero-fix: atan2(0,0) is undefined in WGSL/GLSL, guarded via CHROMA_EPSILON)', () => {
    const result = applyAdjustColor(GRAY, { saturation: 1.0 })
    expect(Number.isFinite(result.r)).toBe(true)
    expect(Number.isFinite(result.g)).toBe(true)
    expect(Number.isFinite(result.b)).toBe(true)
    expect(result.r).toBeCloseTo(GRAY.r, 2)
    expect(result.g).toBeCloseTo(GRAY.g, 2)
    expect(result.b).toBeCloseTo(GRAY.b, 2)
  })
})

describe('applyBlackAndWhite', () => {
  it('intensity=0 is identity', () => {
    const result = applyBlackAndWhite(RED, { intensity: 0, neutrals: 0, tone: 0 })
    expect(result.r).toBeCloseTo(RED.r)
    expect(result.g).toBeCloseTo(RED.g)
    expect(result.b).toBeCloseTo(RED.b)
  })

  it('intensity=1 produces R=G=B', () => {
    const result = applyBlackAndWhite(RED, { intensity: 1, neutrals: 0, tone: 0 })
    expect(result.r).toBeCloseTo(result.g)
    expect(result.g).toBeCloseTo(result.b)
  })

  it('positive neutrals skews the gray weight toward green (mirrors grayscaleMatrix)', () => {
    const greenish: RGBA = { r: 0.2, g: 0.9, b: 0.2, a: 1 }
    const skewedUp = applyBlackAndWhite(greenish, { intensity: 1, neutrals: 1, tone: 0 })
    const skewedDown = applyBlackAndWhite(greenish, { intensity: 1, neutrals: -1, tone: 0 })
    // more green weight on a green-heavy pixel -> brighter gray output
    expect(skewedUp.r).toBeGreaterThan(skewedDown.r)
  })
})

describe('applyUnsharpMask', () => {
  it('intensity=0 leaves the pixel unchanged regardless of blur', () => {
    const blurred: RGBA = { r: 0.3, g: 0.3, b: 0.3, a: 1 }
    const result = applyUnsharpMask(GRAY, blurred, 0)
    expect(result.r).toBeCloseTo(GRAY.r, 2)
  })

  it('exaggerates the difference from the blurred pixel when intensity > 0 (rgb mode)', () => {
    const blurred: RGBA = { r: 0.3, g: 0.3, b: 0.3, a: 1 }
    const result = applyUnsharpMask(GRAY, blurred, 1, 'rgb')
    expect(result.r).toBeGreaterThan(GRAY.r)
  })

  it('exaggerates the difference from the blurred pixel when intensity > 0 (lab-l mode, above the x1 coring threshold)', () => {
    const blurred: RGBA = { r: 0.3, g: 0.3, b: 0.3, a: 1 }
    const result = applyUnsharpMask(GRAY, blurred, 1)
    expect(result.r).toBeGreaterThan(GRAY.r)
  })

  it('coring gate: a tiny blur difference (|diff| <= x1=2 L* units) leaves the pixel unchanged even at full intensity', () => {
    // GRAY vs a barely-brighter blur -- L* difference is well under the x1=2
    // flat/jaggy threshold (root cause of the real-photo noise-amplification
    // symptom recorded against V-2: compression noise has exactly this shape).
    const blurred: RGBA = { r: 0.505, g: 0.505, b: 0.505, a: 1 }
    const result = applyUnsharpMask(GRAY, blurred, 1)
    expect(result.r).toBeCloseTo(GRAY.r, 2)
    expect(result.g).toBeCloseTo(GRAY.g, 2)
    expect(result.b).toBeCloseTo(GRAY.b, 2)
  })

  it('clamps the response at the y2/y3 bound instead of diverging for very large differences', () => {
    const veryDark: RGBA = { r: 0.02, g: 0.02, b: 0.02, a: 1 }
    const pitchBlack: RGBA = { r: 0, g: 0, b: 0, a: 1 }
    // Both differences from GRAY already exceed the y2=10 L*-unit clamp at
    // m2=3*intensity=3, so a bigger difference must not sharpen further.
    const resultA = applyUnsharpMask(GRAY, veryDark, 1)
    const resultB = applyUnsharpMask(GRAY, pitchBlack, 1)
    expect(resultA.r).toBeCloseTo(resultB.r, 2)
  })
})

describe('gaussianKernel1D', () => {
  it('weights sum to 1', () => {
    const weights = gaussianKernel1D(0.5, 2)
    const sum = weights.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1)
  })

  it('is symmetric and peaks at the center', () => {
    const weights = gaussianKernel1D(0.5, 2)
    expect(weights).toHaveLength(5)
    expect(weights[0]).toBeCloseTo(weights[4])
    expect(weights[1]).toBeCloseTo(weights[3])
    expect(weights[2]).toBeGreaterThan(weights[1])
  })
})

describe('collectOrderedAdjustmentSteps', () => {
  it('preserves recipe order and includes duplicates', () => {
    const recipe: Recipe = {
      steps: [
        { id: '1', processor: 'image.sharpen', params: { intensity: 0.5 } },
        { id: '2', processor: 'image.resize', params: { width: 100, height: 100, fit: 'inside' } },
        { id: '3', processor: 'image.adjustLight', params: { exposure: 1, brightness: 0, contrast: 0, blackPoint: 0 } },
        { id: '4', processor: 'image.sharpen', params: { intensity: 0.2 } },
      ],
    }

    const steps = collectOrderedAdjustmentSteps(recipe)
    expect(steps.map((s) => s.id)).toEqual(['1', '3', '4'])
  })

  it('ignores image.convert and image.compress', () => {
    const recipe: Recipe = {
      steps: [
        { id: '1', processor: 'image.convert', params: { format: 'webp', quality: 85 } },
        { id: '2', processor: 'image.compress', params: { quality: 70 } },
      ],
    }

    expect(collectOrderedAdjustmentSteps(recipe)).toEqual([])
  })
})
