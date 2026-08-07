import type { CropParams } from '@/lib/recipe/schema'

export interface DragRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface CanvasSize {
  width: number
  height: number
}

// Below this many CSS pixels in either dimension, a drag is treated as a
// click/mis-drag rather than an intentional crop selection -- returns null
// (no crop change) instead of committing a sliver-sized rect nobody meant to
// draw.
const MIN_DRAG_PIXELS = 4

// Converts a pointer-drag rectangle (CropControl.tsx, in the crop canvas's
// own CSS-pixel space -- that canvas always draws the untouched source
// ImageBitmap at a known display size, so this is already
// original-source-relative, no further coordinate-frame translation needed;
// see docs/tasks/TASK-crop-preview-parity.md "Porquê") into normalized
// cropParamsSchema fields. Pure/DOM-free so it's directly unit-testable,
// same reason light-blend.ts's applyLightBlend was extracted from its
// control component.
export function dragRectToCropParams(drag: DragRect, canvasSize: CanvasSize): CropParams | null {
  const left = Math.min(drag.x0, drag.x1)
  const right = Math.max(drag.x0, drag.x1)
  const top = Math.min(drag.y0, drag.y1)
  const bottom = Math.max(drag.y0, drag.y1)

  const clampedLeft = Math.max(0, Math.min(canvasSize.width, left))
  const clampedRight = Math.max(0, Math.min(canvasSize.width, right))
  const clampedTop = Math.max(0, Math.min(canvasSize.height, top))
  const clampedBottom = Math.max(0, Math.min(canvasSize.height, bottom))

  if (clampedRight - clampedLeft < MIN_DRAG_PIXELS || clampedBottom - clampedTop < MIN_DRAG_PIXELS) {
    return null
  }

  return {
    x: clampedLeft / canvasSize.width,
    y: clampedTop / canvasSize.height,
    width: (clampedRight - clampedLeft) / canvasSize.width,
    height: (clampedBottom - clampedTop) / canvasSize.height,
  }
}
