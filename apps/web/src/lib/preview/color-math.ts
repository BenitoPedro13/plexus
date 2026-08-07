import type {
  AdjustColorParams,
  AdjustLightParams,
  BlackAndWhiteParams,
  Recipe,
  RecipeStep,
} from '@/lib/recipe/schema'

// Pure-TS reference implementation of the four composite processors'
// per-pixel math -- the source every WGSL (webgpu-renderer.ts) and GLSL
// (webgl2-renderer.ts) snippet is hand-transcribed from, and the only part
// of this task unit-testable without a real browser. All pixel values are
// normalized 0..1 (shader-native), not 0..255 (Go/govips-native) -- callers
// convert at the boundary. Clamping happens once, at the very end of a
// pass, not between each chained op -- govips's per-op clamping behavior on
// 8-bit images is unverified (folded into the existing V-2 "measure drift
// per control" mandate rather than a new register entry) and this is a
// preview approximation by design, not a bit-exact re-implementation.

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

// Mirrors workers/internal/processors/adjust_light.go's four chained
// Linear1 passes, in the same order (exposure -> brightness -> contrast ->
// blackPoint), translated from Go's 0..255 Linear1(a, b) coefficients to
// 0..1 space (brightness*255 -> brightness, -128*contrast -> -0.5*contrast,
// etc). RGB only -- alpha passed through unchanged; see D-20
// (docs/90-deferred-register.md): Go's Linear1 applies uniformly to every
// band including alpha (no exemption in adjust_light.go), which the shader
// deliberately does not replicate.
export function applyAdjustLight(pixel: RGBA, params: AdjustLightParams): RGBA {
  const { exposure, brightness, contrast, blackPoint } = params
  const denom = Math.max(1 - blackPoint, 1e-6)

  const transform = (channel: number): number => {
    let x = channel * Math.pow(2, exposure)
    x = x + brightness
    x = x * (1 + contrast) - 0.5 * contrast
    x = (x - blackPoint) / denom
    return clamp01(x)
  }

  return { r: transform(pixel.r), g: transform(pixel.g), b: transform(pixel.b), a: pixel.a }
}

// --- CIE Lab/LCh (D65), Bruce Lindbloom's reference sRGB<->XYZ matrices ---
// Standard CIE 1976 color science, not vips-specific -- but whether
// Modulate's ToColorSpace(LCH) round trip uses this exact white point and
// gamut-clamping strategy is V-11 (docs/90-deferred-register.md), unverified.

const D65_XN = 0.95047
const D65_YN = 1.0
const D65_ZN = 1.08883
const LAB_EPSILON = Math.pow(6 / 29, 3)
const LAB_KAPPA = 1 / (3 * Math.pow(6 / 29, 2))

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function labF(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : LAB_KAPPA * t + 4 / 29
}

function labFInverse(t: number): number {
  const t3 = t * t * t
  return t3 > LAB_EPSILON ? t3 : (t - 4 / 29) / LAB_KAPPA
}

export interface Lab {
  l: number
  a: number
  b: number
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb

  const fx = labF(x / D65_XN)
  const fy = labF(y / D65_YN)
  const fz = labF(z / D65_ZN)

  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

function labToRgb(lab: Lab): { r: number; g: number; b: number } {
  const fy = (lab.l + 16) / 116
  const fx = fy + lab.a / 500
  const fz = fy - lab.b / 200

  const x = D65_XN * labFInverse(fx)
  const y = D65_YN * labFInverse(fy)
  const z = D65_ZN * labFInverse(fz)

  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z

  return { r: clamp01(linearToSrgb(lr)), g: clamp01(linearToSrgb(lg)), b: clamp01(linearToSrgb(lb)) }
}

// Mirrors workers/internal/processors/adjust_color.go's
// img.Modulate(1, 1+saturation, 0): convert to LCh, scale chroma by
// (1+saturation), convert back. Brightness/hue untouched (matches the
// fixed 1 / 0 arguments Go passes).
// atan2(0, 0) is well-defined in JS (0) but undefined in WGSL/GLSL (NaN or
// driver-dependent garbage -- see TASK-adjust-color-atan2-zero-fix.md), so
// the hue computation is guarded the same way here as in the shaders even
// though this JS path never hit the bug: below CHROMA_EPSILON the boosted
// chroma is negligible regardless of hue, so skipping atan2/cos/sin changes
// no visible output.
const CHROMA_EPSILON = 1e-4

export function applyAdjustColor(pixel: RGBA, params: AdjustColorParams): RGBA {
  const lab = rgbToLab(pixel.r, pixel.g, pixel.b)
  const chroma = Math.hypot(lab.a, lab.b)
  const scaledChroma = Math.max(0, chroma * (1 + params.saturation))

  let a = 0
  let b = 0
  if (chroma > CHROMA_EPSILON) {
    const hue = Math.atan2(lab.b, lab.a)
    a = scaledChroma * Math.cos(hue)
    b = scaledChroma * Math.sin(hue)
  }

  const rgb = labToRgb({ l: lab.l, a, b })

  return { ...rgb, a: pixel.a }
}

// Mirrors workers/internal/processors/black_and_white.go's
// grayscaleMatrix(neutrals) weights exactly, then the same post-grayscale
// Linear1 contrast formula as adjustLight's `contrast`, then a linear blend
// with the original by `intensity` (Go's img.Linear1(1-intensity, 0) +
// gray.Linear1(intensity, 0) + img.Add(gray), collapsed to one mix()).
export function applyBlackAndWhite(pixel: RGBA, params: BlackAndWhiteParams): RGBA {
  const { intensity, neutrals, tone } = params
  const green = 1 / 3 + neutrals / 3
  const redBlue = (1 - green) / 2

  const gray = redBlue * pixel.r + green * pixel.g + redBlue * pixel.b
  const toned = gray * (1 + tone) - 0.5 * tone

  const mix = (original: number): number => clamp01(original * (1 - intensity) + toned * intensity)

  return { r: mix(pixel.r), g: mix(pixel.g), b: mix(pixel.b), a: pixel.a }
}

// Unsharp-mask composite half of workers/internal/processors/sharpen.go's
// img.Sharpen(0.5, 2, 3*intensity) -- the Gaussian-blur half is a spatial
// pass, not expressible as a per-pixel function (see gaussianKernel1D
// below; the renderers run it as its own draw pass).
//
// Whether libvips' sharpen operates on the L channel of a Lab-like
// colourspace only, or on RGB directly, was V-10 (docs/90-deferred-register.md)
// -- confirmed from libvips/libvips/convolution/sharpen.c: L channel only.
// `colorSpace` defaults to 'lab-l'; 'rgb' remains as a non-production
// fallback.
//
// libvips' response isn't a single unconditional slope -- it's piecewise
// (sharpen.c): |diff| <= x1 (a "flat" area -- noise, smooth gradients) gets
// slope m1=0, i.e. no sharpening at all; only |diff| > x1 (a real edge)
// gets slope m2. The result is then clamped to [-y3, y2]. govips'
// Sharpen(sigma, x1, m2) (image_pixel.go, v2.18.0) only sets Sigma/X1/M2 in
// SharpenOptions -- M1/Y2/Y3 are left nil, so libvips' own C defaults apply:
// m1=0, y2=10, y3=20 (L* units, per libvips' sharpen docs). Omitting this
// coring gate was the root cause of the real-photo noise-amplification
// symptom recorded against V-2: ordinary compression noise in flat regions
// has small |diff| and should get zero response, not m2's full slope.
const SHARPEN_X1 = 2
const SHARPEN_Y2 = 10
const SHARPEN_Y3 = 20

function sharpenResponse(diff: number, m2: number, x1: number, y2: number, y3: number): number {
  const slope = Math.abs(diff) <= x1 ? 0 : m2
  return Math.min(y2, Math.max(-y3, slope * diff))
}

export function applyUnsharpMask(
  pixel: RGBA,
  blurredPixel: RGBA,
  intensity: number,
  colorSpace: 'rgb' | 'lab-l' = 'lab-l',
): RGBA {
  const m2 = 3 * intensity

  if (colorSpace === 'rgb') {
    // Not the production path (V-10 confirmed libvips uses Lab L only) --
    // same piecewise shape, x1/y2/y3 scaled from L* units (0..100) to this
    // branch's 0..1 range for dimensional consistency.
    const sharpen = (original: number, blurred: number): number =>
      clamp01(original + sharpenResponse(original - blurred, m2, SHARPEN_X1 / 100, SHARPEN_Y2 / 100, SHARPEN_Y3 / 100))
    return {
      r: sharpen(pixel.r, blurredPixel.r),
      g: sharpen(pixel.g, blurredPixel.g),
      b: sharpen(pixel.b, blurredPixel.b),
      a: pixel.a,
    }
  }

  const lab = rgbToLab(pixel.r, pixel.g, pixel.b)
  const blurredLab = rgbToLab(blurredPixel.r, blurredPixel.g, blurredPixel.b)
  const sharpenedL = lab.l + sharpenResponse(lab.l - blurredLab.l, m2, SHARPEN_X1, SHARPEN_Y2, SHARPEN_Y3)

  const rgb = labToRgb({ l: sharpenedL, a: lab.a, b: lab.b })
  return { ...rgb, a: pixel.a }
}

// Normalized 1D Gaussian kernel, `2*radius + 1` taps. sigma=0.5 (the fixed
// sigma workers/internal/processors/sharpen.go passes to img.Sharpen) with
// radius=ceil(3*sigma)=2 covers >99% of the kernel's mass. Separable --
// the renderers apply this horizontally then vertically, two passes.
export function gaussianKernel1D(sigma: number, radius: number): number[] {
  const weights: number[] = []
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    weights.push(w)
    sum += w
  }
  return weights.map((w) => w / sum)
}

export type AdjustmentStep = Extract<
  RecipeStep,
  { processor: 'image.adjustLight' | 'image.adjustColor' | 'image.blackAndWhite' | 'image.sharpen' }
>

const ADJUSTMENT_PROCESSOR_IDS: ReadonlySet<AdjustmentStep['processor']> = new Set([
  'image.adjustLight',
  'image.adjustColor',
  'image.blackAndWhite',
  'image.sharpen',
])

function isAdjustmentStep(step: RecipeStep): step is AdjustmentStep {
  return ADJUSTMENT_PROCESSOR_IDS.has(step.processor as AdjustmentStep['processor'])
}

// Every composite-adjustment step in recipe.steps, in original array order,
// duplicates included -- a recipe that repeats a processor is legal and Go
// applies it twice, so the preview must too. image.resize/convert/compress
// are excluded; geometry.ts's findLastResizeStep() still owns resize.
export function collectOrderedAdjustmentSteps(recipe: Recipe): AdjustmentStep[] {
  return recipe.steps.filter(isAdjustmentStep)
}
