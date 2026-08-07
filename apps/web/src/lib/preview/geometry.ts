import type { CropParams, Recipe, RecipeStep, ResizeParams } from '@/lib/recipe/schema'

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
type CropStep = Extract<RecipeStep, { processor: 'image.crop' }>

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

// Same "last one wins" convention as findLastResizeStep, kept only for
// symmetry/direct testing -- computeGeometryChain below does NOT use this
// (unlike resize, crop's position relative to other geometry steps is
// load-bearing, so the chain walks the full recipe in order instead of
// picking one step).
export function findLastCropStep(recipe: Recipe): CropStep | undefined {
  for (let i = recipe.steps.length - 1; i >= 0; i--) {
    const step = recipe.steps[i]
    if (step.processor === 'image.crop') {
      return step
    }
  }
  return undefined
}

// Remaps a UV rect expressed relative to `parent`'s own 0..1 space into the
// space `parent` itself is expressed in (e.g. original-source UV) -- used to
// compose successive geometry steps' UV rects, each of which is naturally
// computed relative to the *previous* step's output, not the original
// source.
function mapUVIntoParent(child: UVRect, parent: UVRect): UVRect {
  const parentWidth = parent.u1 - parent.u0
  const parentHeight = parent.v1 - parent.v0
  return {
    u0: parent.u0 + child.u0 * parentWidth,
    v0: parent.v0 + child.v0 * parentHeight,
    u1: parent.u0 + child.u1 * parentWidth,
    v1: parent.v0 + child.v1 * parentHeight,
  }
}

// Mirrors workers/internal/processors/crop.go's pixel rounding and clamping
// exactly (Math.round, then clamp so rounding can never push the rect past
// the *current* image's bounds), against `currentDims` -- crop's params are
// fractions of whatever image is input to that step, not the original
// source (confirmed by reading crop.go directly).
function applyCropStep(
  currentDims: ImageDimensions,
  params: CropParams,
): { dims: ImageDimensions; uv: UVRect } {
  const srcW = currentDims.width
  const srcH = currentDims.height

  let left = Math.round(params.x * srcW)
  let top = Math.round(params.y * srcH)
  let cropW = Math.round(params.width * srcW)
  let cropH = Math.round(params.height * srcH)

  if (left > srcW - 1) left = srcW - 1
  if (top > srcH - 1) top = srcH - 1
  if (left + cropW > srcW) cropW = srcW - left
  if (top + cropH > srcH) cropH = srcH - top
  if (cropW < 1) cropW = 1
  if (cropH < 1) cropH = 1

  return {
    dims: { width: cropW, height: cropH },
    uv: {
      u0: left / srcW,
      v0: top / srcH,
      u1: (left + cropW) / srcW,
      v1: (top + cropH) / srcH,
    },
  }
}

// Composes every image.crop/image.resize step in `recipe.steps`, in true
// recipe order, into a single final-blit UV rect (expressed in original
// source UV space) plus final output pixel dimensions -- the generalization
// of the old findLastResizeStep+computeFitGeometry pair once a second
// geometry-affecting processor (crop) exists. Unlike resize alone, crop and
// resize do not commute: crop's fractions are relative to whichever image is
// current at that point in the recipe, so `crop -> resize` and
// `resize -> crop` produce genuinely different composed rects (see
// docs/tasks/TASK-crop-preview-parity.md "Porquê"). Content-adjustment steps
// (adjustLight/adjustColor/blackAndWhite/sharpen) are skipped here --
// unaffected by geometry, unchanged from D-21's existing simplification,
// which now also covers crop's position relative to those steps.
export function computeGeometryChain(source: ImageDimensions, recipe: Recipe): FitGeometry {
  let currentDims: ImageDimensions = { ...source }
  let currentUV: UVRect = { ...FULL_UNIT_SQUARE }

  for (const step of recipe.steps) {
    if (step.processor === 'image.crop') {
      const { dims, uv } = applyCropStep(currentDims, step.params)
      currentDims = dims
      currentUV = mapUVIntoParent(uv, currentUV)
    } else if (step.processor === 'image.resize') {
      const fit = computeFitGeometry(currentDims, step.params)
      currentDims = { width: fit.outputWidth, height: fit.outputHeight }
      currentUV = mapUVIntoParent(fit.sourceUV, currentUV)
    }
  }

  return {
    outputWidth: currentDims.width,
    outputHeight: currentDims.height,
    sourceUV: currentUV,
  }
}
