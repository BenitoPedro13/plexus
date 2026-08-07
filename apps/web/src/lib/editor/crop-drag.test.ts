import { describe, expect, it } from 'vitest'
import { dragRectToCropParams } from './crop-drag'

const canvasSize = { width: 200, height: 100 }

describe('dragRectToCropParams', () => {
  it('converts a straightforward top-left-to-bottom-right drag', () => {
    const params = dragRectToCropParams({ x0: 50, y0: 20, x1: 150, y1: 80 }, canvasSize)

    expect(params).toEqual({ x: 0.25, y: 0.2, width: 0.5, height: 0.6 })
  })

  it('normalizes a reversed-direction drag (bottom-right to top-left)', () => {
    const params = dragRectToCropParams({ x0: 150, y0: 80, x1: 50, y1: 20 }, canvasSize)

    expect(params).toEqual({ x: 0.25, y: 0.2, width: 0.5, height: 0.6 })
  })

  it('clamps a drag that extends past the canvas bounds', () => {
    const params = dragRectToCropParams({ x0: -50, y0: -20, x1: 250, y1: 120 }, canvasSize)

    expect(params).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('returns null for a below-floor drag (click / mis-drag)', () => {
    const params = dragRectToCropParams({ x0: 50, y0: 20, x1: 51, y1: 21 }, canvasSize)

    expect(params).toBeNull()
  })

  it('an exact full-canvas drag yields the identity crop rect', () => {
    const params = dragRectToCropParams({ x0: 0, y0: 0, x1: 200, y1: 100 }, canvasSize)

    expect(params).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})
