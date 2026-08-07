import { describe, expect, it } from 'vitest'
import type { Recipe } from '@/lib/recipe/schema'
import { computeFitGeometry, computeGeometryChain } from './geometry'

describe('computeFitGeometry', () => {
  it('inside: scales to fit within the box with no crop, full source visible', () => {
    const geometry = computeFitGeometry(
      { width: 800, height: 600 },
      { width: 400, height: 400, fit: 'inside' },
    )

    // scale = min(400/800, 400/600) = 0.5
    expect(geometry.outputWidth).toBeCloseTo(400)
    expect(geometry.outputHeight).toBeCloseTo(300)
    expect(geometry.sourceUV).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 })
  })

  it('cover: crops to exactly fill the box, centered', () => {
    const geometry = computeFitGeometry(
      { width: 800, height: 600 },
      { width: 400, height: 400, fit: 'cover' },
    )

    // scale = max(400/800, 400/600) = 2/3; scaledWidth = 533.33, scaledHeight = 400
    expect(geometry.outputWidth).toBe(400)
    expect(geometry.outputHeight).toBe(400)
    expect(geometry.sourceUV.v0).toBeCloseTo(0)
    expect(geometry.sourceUV.v1).toBeCloseTo(1)
    expect(geometry.sourceUV.u0).toBeCloseTo(0.125)
    expect(geometry.sourceUV.u1).toBeCloseTo(0.875)
  })

  it('cover: source UV is the full unit square when aspect ratios already match', () => {
    const geometry = computeFitGeometry(
      { width: 1000, height: 500 },
      { width: 400, height: 200, fit: 'cover' },
    )

    expect(geometry.sourceUV).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 })
  })

  it('inside: handles a degenerate 1x1 target', () => {
    const geometry = computeFitGeometry(
      { width: 800, height: 600 },
      { width: 1, height: 1, fit: 'inside' },
    )

    expect(geometry.outputWidth).toBeCloseTo(1)
    expect(geometry.outputHeight).toBeCloseTo(0.75)
  })

  it('cover: handles a target taller than it is wide relative to source', () => {
    const geometry = computeFitGeometry(
      { width: 800, height: 600 },
      { width: 300, height: 600, fit: 'cover' },
    )

    // scale = max(300/800, 600/600) = 1; scaledWidth = 800, scaledHeight = 600
    expect(geometry.outputWidth).toBe(300)
    expect(geometry.outputHeight).toBe(600)
    expect(geometry.sourceUV.u0).toBeCloseTo(0.3125)
    expect(geometry.sourceUV.u1).toBeCloseTo(0.6875)
    expect(geometry.sourceUV.v0).toBeCloseTo(0)
    expect(geometry.sourceUV.v1).toBeCloseTo(1)
  })
})

describe('computeGeometryChain', () => {
  it('crop-only: composes the exact crop rect against the source', () => {
    const recipe: Recipe = {
      steps: [
        { id: 'crop', processor: 'image.crop', params: { x: 0.25, y: 0, width: 0.5, height: 1 } },
      ],
    }

    const geometry = computeGeometryChain({ width: 800, height: 600 }, recipe)

    expect(geometry.outputWidth).toBe(400)
    expect(geometry.outputHeight).toBe(600)
    expect(geometry.sourceUV).toEqual({ u0: 0.25, v0: 0, u1: 0.75, v1: 1 })
  })

  it('resize-only: matches a direct computeFitGeometry call (regression guard)', () => {
    const source = { width: 800, height: 600 }
    const params = { width: 400, height: 400, fit: 'inside' as const }
    const recipe: Recipe = {
      steps: [{ id: 'resize', processor: 'image.resize', params }],
    }

    const direct = computeFitGeometry(source, params)
    const chained = computeGeometryChain(source, recipe)

    expect(chained).toEqual(direct)
  })

  it('no crop/resize steps: falls back to the full source, unit square', () => {
    const recipe: Recipe = {
      steps: [
        { id: 'light', processor: 'image.adjustLight', params: { exposure: 0.5, brightness: 0, contrast: 0, blackPoint: 0, highlights: 0, shadows: 0 } },
      ],
    }

    const geometry = computeGeometryChain({ width: 800, height: 600 }, recipe)

    expect(geometry).toEqual({
      outputWidth: 800,
      outputHeight: 600,
      sourceUV: { u0: 0, v0: 0, u1: 1, v1: 1 },
    })
  })

  it('crop then resize vs. resize then crop: order changes the composed result', () => {
    const source = { width: 800, height: 600 }
    const cropParams = { x: 0.5, y: 0, width: 0.5, height: 1 }
    const resizeParams = { width: 100, height: 300, fit: 'cover' as const }

    const cropThenResize: Recipe = {
      steps: [
        { id: 'crop', processor: 'image.crop', params: cropParams },
        { id: 'resize', processor: 'image.resize', params: resizeParams },
      ],
    }
    const resizeThenCrop: Recipe = {
      steps: [
        { id: 'resize', processor: 'image.resize', params: resizeParams },
        { id: 'crop', processor: 'image.crop', params: cropParams },
      ],
    }

    const a = computeGeometryChain(source, cropThenResize)
    const b = computeGeometryChain(source, resizeThenCrop)

    // crop -> resize: crop to the right half (400x600), then cover-resize
    // that to 100x300.
    expect(a.outputWidth).toBeCloseTo(100)
    expect(a.outputHeight).toBeCloseTo(300)
    expect(a.sourceUV.u0).toBeCloseTo(0.625)
    expect(a.sourceUV.u1).toBeCloseTo(0.875)

    // resize -> crop: cover-resize to 100x300 first, then crop the right
    // half of *that* (50x300) -- a genuinely different rect and pixel size.
    expect(b.outputWidth).toBeCloseTo(50)
    expect(b.outputHeight).toBeCloseTo(300)
    expect(b.sourceUV.u0).toBeCloseTo(0.5)
    expect(b.sourceUV.u1).toBeCloseTo(0.625)

    expect(a).not.toEqual(b)
  })

  it('crop rounding at an odd source dimension mirrors crop.go\'s Math.round', () => {
    const recipe: Recipe = {
      steps: [
        { id: 'crop', processor: 'image.crop', params: { x: 0, y: 0, width: 1 / 3, height: 1 } },
      ],
    }

    const geometry = computeGeometryChain({ width: 65, height: 40 }, recipe)

    // round(0.3333... * 65) = round(21.666...) = 22
    expect(geometry.outputWidth).toBe(22)
    expect(geometry.outputHeight).toBe(40)
  })
})
