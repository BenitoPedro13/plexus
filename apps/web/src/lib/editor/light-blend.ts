import type { AdjustLightParams } from '@/lib/recipe/schema'

// Blend ratios for the single "Light" master slider -> the four P0
// image.adjustLight params. Not a claim about Apple Photos' internal curve
// (closed-source, unverifiable) -- this is the UI-only judgment call
// docs/tasks/TASK-composite-slider-mapping.md explicitly deferred to this
// task. See docs/tasks/TASK-editor-composite-ui.md for the reasoning.
// highlights/shadows are left at 0 (no-op) here -- the Light master slider's
// blend ratios only cover the original four P0 params; wiring highlights/
// shadows into this blend (and into a live preview) is out of scope for
// TASK-highlights-shadows-tonelut.md, tracked as its own follow-on D-xx in
// docs/90-deferred-register.md.
export function applyLightBlend(t: number): AdjustLightParams {
  const clamped = Math.max(-1, Math.min(1, t))
  return {
    exposure: clamped * 1.5,
    brightness: clamped * 0.3,
    contrast: clamped * 0.25,
    blackPoint: clamped < 0 ? -clamped * 0.3 : 0,
    highlights: 0,
    shadows: 0,
  }
}

export const identityLightParams: AdjustLightParams = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  blackPoint: 0,
  highlights: 0,
  shadows: 0,
}
