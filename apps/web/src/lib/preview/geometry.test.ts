import { describe, expect, it } from 'vitest'
import { computeFitGeometry } from './geometry'

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
