import type { AdjustLightParams } from '@/lib/recipe/schema'

// Blend ratios for the single "Light" master slider -> the four P0
// image.adjustLight params. Not a claim about Apple Photos' internal curve
// (closed-source, unverifiable) -- this is the UI-only judgment call
// docs/tasks/TASK-composite-slider-mapping.md explicitly deferred to this
// task. See docs/tasks/TASK-editor-composite-ui.md for the reasoning.
export function applyLightBlend(t: number): AdjustLightParams {
  const clamped = Math.max(-1, Math.min(1, t))
  return {
    exposure: clamped * 1.5,
    brightness: clamped * 0.3,
    contrast: clamped * 0.25,
    blackPoint: clamped < 0 ? -clamped * 0.3 : 0,
  }
}

export const identityLightParams: AdjustLightParams = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  blackPoint: 0,
}
