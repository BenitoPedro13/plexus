import { describe, expect, it } from 'vitest'
import { applyLightBlend, identityLightParams } from './light-blend'

describe('applyLightBlend', () => {
  it('is the identity at t=0', () => {
    expect(applyLightBlend(0)).toEqual(identityLightParams)
  })

  it('brightens at t=1 without touching blackPoint', () => {
    expect(applyLightBlend(1)).toEqual({
      exposure: 1.5,
      brightness: 0.3,
      contrast: 0.25,
      blackPoint: 0,
      highlights: 0,
      shadows: 0,
    })
  })

  it('darkens at t=-1 and deepens blackPoint', () => {
    expect(applyLightBlend(-1)).toEqual({
      exposure: -1.5,
      brightness: -0.3,
      contrast: -0.25,
      blackPoint: 0.3,
      highlights: 0,
      shadows: 0,
    })
  })

  it('clamps out-of-range input to [-1, 1]', () => {
    expect(applyLightBlend(5)).toEqual(applyLightBlend(1))
    expect(applyLightBlend(-5)).toEqual(applyLightBlend(-1))
  })
})
