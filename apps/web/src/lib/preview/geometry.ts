import type { Recipe, RecipeStep, ResizeParams } from '@/lib/recipe/schema'

export interface ImageDimensions {
  width: number
  height: number
}

export interface UVRect {
  u0: number
  v0: number
  u1: number
  v1: number
}

export interface FitGeometry {
  outputWidth: number
  outputHeight: number
  sourceUV: UVRect
}

const FULL_UNIT_SQUARE: UVRect = { u0: 0, v0: 0, u1: 1, v1: 1 }

// Mirrors workers/internal/processors/resize.go's two `fit` behaviors:
// "inside" == vips.InterestingNone (scale to fit within the box, no crop,
// output dimensions vary), "cover" == vips.InterestingCentre (crop to
// exactly fill the box, output dimensions are always width x height).
export function computeFitGeometry(
  source: ImageDimensions,
  params: ResizeParams,
): FitGeometry {
  const { width: targetWidth, height: targetHeight, fit } = params

  if (fit === 'cover') {
    const scale = Math.max(
      targetWidth / source.width,
      targetHeight / source.height,
    )
    const scaledWidth = source.width * scale
    const scaledHeight = source.height * scale
    const visibleUFraction = targetWidth / scaledWidth
    const visibleVFraction = targetHeight / scaledHeight
    const u0 = (1 - visibleUFraction) / 2
    const v0 = (1 - visibleVFraction) / 2

    return {
      outputWidth: targetWidth,
      outputHeight: targetHeight,
      sourceUV: {
        u0,
        v0,
        u1: u0 + visibleUFraction,
        v1: v0 + visibleVFraction,
      },
    }
  }

  const scale = Math.min(
    targetWidth / source.width,
    targetHeight / source.height,
  )

  return {
    outputWidth: source.width * scale,
    outputHeight: source.height * scale,
    sourceUV: FULL_UNIT_SQUARE,
  }
}

// Both render backends need this: the size chain for the mean-downsample
// pyramid image.adjustColor's castStrength uses (webgpu-renderer.ts's
// encodeMeanChain / webgl2-renderer.ts's equivalent, TASK-color-cast-preview-parity.md).
// Each step halves both dimensions (rounding up, so an odd size still
// terminates), ending at 1x1 -- that final 1x1 texture holds the whole
// image's average color once every level has been rendered.
export function computeMeanChainSizes(source: ImageDimensions): ImageDimensions[] {
  const sizes: ImageDimensions[] = []
  let width = source.width
  let height = source.height
  while (width > 1 || height > 1) {
    width = Math.max(1, Math.ceil(width / 2))
    height = Math.max(1, Math.ceil(height / 2))
    sizes.push({ width, height })
  }
  return sizes
}

type ResizeStep = Extract<RecipeStep, { processor: 'image.resize' }>

// Both render backends need this: a recipe with more than one image.resize
// step (not expected in practice today, Phase 2 recipes are short) uses the
// last one, mirroring "later steps win" for any other field a recipe might
// eventually repeat.
export function findLastResizeStep(recipe: Recipe): ResizeStep | undefined {
  for (let i = recipe.steps.length - 1; i >= 0; i--) {
    const step = recipe.steps[i]
    if (step.processor === 'image.resize') {
      return step
    }
  }
  return undefined
}
