/// <reference types="@webgpu/types" />
import type { Recipe } from '@/lib/recipe/schema'
import { collectOrderedAdjustmentSteps, gaussianKernel1D, type AdjustmentStep } from './color-math'
import { computeFitGeometry, findLastResizeStep } from './geometry'
import type { PreviewRenderer } from './types'

// Radius=2 (5-tap) at the Go processor's fixed sigma=0.5
// (workers/internal/processors/sharpen.go) covers >99% of the kernel's
// mass. Computed once here (color-math.ts is the single source of truth)
// and inlined as WGSL/GLSL literals below, not recomputed per-frame.
const GAUSSIAN_RADIUS = 2
const GAUSSIAN_WEIGHTS = gaussianKernel1D(0.5, GAUSSIAN_RADIUS)

// Vertex shader emits a full-canvas quad (two triangles, NDC -1..1) and maps
// each vertex's local UV through a uniform rect produced by
// computeFitGeometry() -- the same rect the WebGL2 renderer consumes, so
// both backends crop/scale identically. localUVs' Y is flipped relative to
// NDC Y (NDC +1 = top of clip space) so v=0 lands on the source image's top
// row -- confirmed against a real headless Chromium (--enable-unsafe-webgpu)
// run with a top/bottom two-tone fixture image, top stayed on top after
// copyExternalImageToTexture() from an ImageBitmap; not yet cross-checked on
// Firefox/Safari's WebGPU implementations. Used only for the *final* blit
// into the visible canvas -- content-adjustment passes below use a simpler
// vertex shader with no crop (they run before geometry is applied, at 1:1
// source resolution; see CONTENT_VERTEX_BLOCK).
const BLIT_SHADER_SOURCE = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@group(0) @binding(0) var<uniform> uvRect: vec4f;
@group(0) @binding(1) var quadSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

const positions = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
);

const localUVs = array<vec2f, 6>(
  vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
  vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
);

@vertex
fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  let localUV = localUVs[vertexIndex];
  out.uv = vec2f(
    mix(uvRect.x, uvRect.z, localUV.x),
    mix(uvRect.y, uvRect.w, localUV.y),
  );
  return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(sourceTexture, quadSampler, in.uv);
}
`

// Shared vertex stage for every content-adjustment pass (adjustLight,
// adjustColor, blackAndWhite, the two blur passes, the unsharp composite):
// a plain full-canvas quad with UV 0..1, no crop -- these passes run
// elementwise against off-screen textures sized to the *source* image's
// dimensions, matching Go where these processors run before/independent of
// resize's geometric resampling (D-21, docs/90-deferred-register.md: resize
// is still applied only as the final blit's UV rect, not a real pass in
// this ordered pipeline).
const CONTENT_VERTEX_BLOCK = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

const contentPositions = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
);
const contentUVs = array<vec2f, 6>(
  vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
  vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
);

@vertex
fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4f(contentPositions[vertexIndex], 0.0, 1.0);
  out.uv = contentUVs[vertexIndex];
  return out;
}
`

// CIE Lab/LCh (D65) helpers shared by adjustColor and the unsharp composite
// pass -- mirrors color-math.ts's rgbToLab/labToRgb exactly (see that
// file's comments for the V-11 caveat on Modulate's exact white point).
const LAB_HELPERS_BLOCK = /* wgsl */ `
fn srgbToLinearChannel(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn linearToSrgbChannel(c: f32) -> f32 {
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

const LAB_EPSILON: f32 = 0.0088564517; // (6/29)^3
const LAB_KAPPA: f32 = 7.787037; // 1 / (3*(6/29)^2)

fn labF(t: f32) -> f32 {
  if (t > LAB_EPSILON) { return pow(t, 1.0 / 3.0); }
  return LAB_KAPPA * t + 4.0 / 29.0;
}

fn labFInverse(t: f32) -> f32 {
  let t3 = t * t * t;
  if (t3 > LAB_EPSILON) { return t3; }
  return (t - 4.0 / 29.0) / LAB_KAPPA;
}

fn rgbToLab(rgb: vec3f) -> vec3f {
  let lr = srgbToLinearChannel(rgb.r);
  let lg = srgbToLinearChannel(rgb.g);
  let lb = srgbToLinearChannel(rgb.b);
  let x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  let y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
  let z = 0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb;
  let fx = labF(x / 0.95047);
  let fy = labF(y / 1.0);
  let fz = labF(z / 1.08883);
  return vec3f(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

fn labToRgb(lab: vec3f) -> vec3f {
  let fy = (lab.x + 16.0) / 116.0;
  let fx = fy + lab.y / 500.0;
  let fz = fy - lab.z / 200.0;
  let x = 0.95047 * labFInverse(fx);
  let y = 1.0 * labFInverse(fy);
  let z = 1.08883 * labFInverse(fz);
  let lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  let lg = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  let lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return clamp(
    vec3f(linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb)),
    vec3f(0.0),
    vec3f(1.0),
  );
}
`

// Mirrors color-math.ts's applyAdjustLight -- params: exposure, brightness,
// contrast, blackPoint (in that order in the uniform vec4f). RGB only;
// alpha passed through unchanged (D-20, docs/90-deferred-register.md).
const ADJUST_LIGHT_WGSL =
  CONTENT_VERTEX_BLOCK +
  /* wgsl */ `
@group(0) @binding(0) var<uniform> params: vec4f;
@group(0) @binding(1) var quadSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

fn adjustLightChannel(c: f32) -> f32 {
  let exposure = params.x;
  let brightness = params.y;
  let contrast = params.z;
  let blackPoint = params.w;
  let denom = max(1.0 - blackPoint, 1e-6);
  var x = c * pow(2.0, exposure);
  x = x + brightness;
  x = x * (1.0 + contrast) - 0.5 * contrast;
  x = (x - blackPoint) / denom;
  return clamp(x, 0.0, 1.0);
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  let c = textureSample(sourceTexture, quadSampler, in.uv);
  return vec4f(adjustLightChannel(c.r), adjustLightChannel(c.g), adjustLightChannel(c.b), c.a);
}
`

// Mirrors color-math.ts's applyAdjustColor -- img.Modulate(1, 1+saturation,
// 0): convert to LCh, scale chroma, convert back. `params.x` = saturation.
const ADJUST_COLOR_WGSL =
  CONTENT_VERTEX_BLOCK +
  LAB_HELPERS_BLOCK +
  /* wgsl */ `
@group(0) @binding(0) var<uniform> params: vec4f;
@group(0) @binding(1) var quadSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  let c = textureSample(sourceTexture, quadSampler, in.uv);
  let lab = rgbToLab(c.rgb);
  let chroma = length(vec2f(lab.y, lab.z));
  let hue = atan2(lab.z, lab.y);
  let scaledChroma = max(0.0, chroma * (1.0 + params.x));
  let newLab = vec3f(lab.x, scaledChroma * cos(hue), scaledChroma * sin(hue));
  return vec4f(labToRgb(newLab), c.a);
}
`

// Mirrors color-math.ts's applyBlackAndWhite -- params: intensity,
// neutrals, tone.
const BLACK_AND_WHITE_WGSL =
  CONTENT_VERTEX_BLOCK +
  /* wgsl */ `
@group(0) @binding(0) var<uniform> params: vec4f;
@group(0) @binding(1) var quadSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  let c = textureSample(sourceTexture, quadSampler, in.uv);
  let intensity = params.x;
  let neutrals = params.y;
  let tone = params.z;
  let green = 1.0 / 3.0 + neutrals / 3.0;
  let redBlue = (1.0 - green) / 2.0;
  let gray = redBlue * c.r + green * c.g + redBlue * c.b;
  let toned = gray * (1.0 + tone) - 0.5 * tone;
  let mixed = clamp(mix(c.rgb, vec3f(toned), intensity), vec3f(0.0), vec3f(1.0));
  return vec4f(mixed, c.a);
}
`

function blurWeightsWGSL(): string {
  return GAUSSIAN_WEIGHTS.map((w) => w.toFixed(8)).join(', ')
}

// Separable Gaussian blur, sigma fixed at 0.5 (matches
// workers/internal/processors/sharpen.go's img.Sharpen(0.5, 2, ...) --
// sigma/x1 are fixed, only m2 varies with intensity). No uniform buffer --
// weights are compile-time constants, direction is baked per-pipeline.
function blurWGSL(direction: 'horizontal' | 'vertical'): string {
  const texelOffset = direction === 'horizontal' ? 'vec2f(1.0 / dims.x, 0.0)' : 'vec2f(0.0, 1.0 / dims.y)'
  return (
    CONTENT_VERTEX_BLOCK +
    /* wgsl */ `
@group(0) @binding(0) var quadSampler: sampler;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;

const kernelWeights = array<f32, ${GAUSSIAN_WEIGHTS.length}>(${blurWeightsWGSL()});

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(sourceTexture));
  let texel = ${texelOffset};
  var sum = vec4f(0.0);
  for (var i = 0; i < ${GAUSSIAN_WEIGHTS.length}; i = i + 1) {
    let offset = f32(i - ${GAUSSIAN_RADIUS});
    sum = sum + textureSample(sourceTexture, quadSampler, in.uv + texel * offset) * kernelWeights[i];
  }
  return sum;
}
`
  )
}

// Unsharp-mask composite: reads the pre-blur ("original") and blurred
// textures, sharpens the Lab L channel only (V-10, color-math.ts's
// applyUnsharpMask default). `params.x` = intensity.
const UNSHARP_WGSL =
  CONTENT_VERTEX_BLOCK +
  LAB_HELPERS_BLOCK +
  /* wgsl */ `
@group(0) @binding(0) var<uniform> params: vec4f;
@group(0) @binding(1) var quadSampler: sampler;
@group(0) @binding(2) var originalTexture: texture_2d<f32>;
@group(0) @binding(3) var blurredTexture: texture_2d<f32>;

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  let orig = textureSample(originalTexture, quadSampler, in.uv);
  let blurred = textureSample(blurredTexture, quadSampler, in.uv);
  let m2 = 3.0 * params.x;
  let origLab = rgbToLab(orig.rgb);
  let blurredLab = rgbToLab(blurred.rgb);
  let sharpenedL = origLab.x + m2 * (origLab.x - blurredLab.x);
  return vec4f(labToRgb(vec3f(sharpenedL, origLab.y, origLab.z)), orig.a);
}
`

const CONTENT_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm'

export class WebGPURenderer implements PreviewRenderer {
  readonly kind = 'webgpu' as const

  private device: GPUDevice | null = null
  private context: GPUCanvasContext | null = null
  private sampler: GPUSampler | null = null

  private blitPipeline: GPURenderPipeline | null = null
  private blitUniformBuffer: GPUBuffer | null = null
  private canvasFormat: GPUTextureFormat | null = null

  private sourceTexture: GPUTexture | null = null
  private texA: GPUTexture | null = null
  private texB: GPUTexture | null = null
  private blurScratchA: GPUTexture | null = null
  private blurScratchB: GPUTexture | null = null

  private adjustLightPipeline: GPURenderPipeline | null = null
  private adjustColorPipeline: GPURenderPipeline | null = null
  private blackAndWhitePipeline: GPURenderPipeline | null = null
  private blurHPipeline: GPURenderPipeline | null = null
  private blurVPipeline: GPURenderPipeline | null = null
  private unsharpPipeline: GPURenderPipeline | null = null

  private sourceDimensions = { width: 0, height: 0 }

  async init(canvas: HTMLCanvasElement, source: ImageBitmap): Promise<void> {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU is not available on this navigator')
    }

    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) {
      throw new Error('No WebGPU adapter available')
    }
    const device = await adapter.requestDevice()

    const context = canvas.getContext('webgpu')
    if (!context) {
      throw new Error('Failed to get a webgpu canvas context')
    }

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format: canvasFormat, alphaMode: 'premultiplied' })

    const sourceTexture = device.createTexture({
      size: [source.width, source.height],
      format: CONTENT_TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: sourceTexture },
      [source.width, source.height],
    )

    const createScratchTexture = (): GPUTexture =>
      device.createTexture({
        size: [source.width, source.height],
        format: CONTENT_TEXTURE_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

    const blitUniformBuffer = device.createBuffer({
      size: 16, // vec4f: u0, v0, u1, v1
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const blitShaderModule = device.createShaderModule({ code: BLIT_SHADER_SOURCE })
    const blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blitShaderModule, entryPoint: 'vertex_main' },
      fragment: { module: blitShaderModule, entryPoint: 'fragment_main', targets: [{ format: canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    })

    const createContentPipeline = (wgsl: string): GPURenderPipeline => {
      const shaderModule = device.createShaderModule({ code: wgsl })
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shaderModule, entryPoint: 'vertex_main' },
        fragment: { module: shaderModule, entryPoint: 'fragment_main', targets: [{ format: CONTENT_TEXTURE_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      })
    }

    this.device = device
    this.context = context
    this.sampler = sampler
    this.blitPipeline = blitPipeline
    this.blitUniformBuffer = blitUniformBuffer
    this.canvasFormat = canvasFormat
    this.sourceTexture = sourceTexture
    this.texA = createScratchTexture()
    this.texB = createScratchTexture()
    this.blurScratchA = createScratchTexture()
    this.blurScratchB = createScratchTexture()
    this.adjustLightPipeline = createContentPipeline(ADJUST_LIGHT_WGSL)
    this.adjustColorPipeline = createContentPipeline(ADJUST_COLOR_WGSL)
    this.blackAndWhitePipeline = createContentPipeline(BLACK_AND_WHITE_WGSL)
    this.blurHPipeline = createContentPipeline(blurWGSL('horizontal'))
    this.blurVPipeline = createContentPipeline(blurWGSL('vertical'))
    this.unsharpPipeline = createContentPipeline(UNSHARP_WGSL)
    this.sourceDimensions = { width: source.width, height: source.height }
  }

  private encodeUniformPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    uniformValues: number[],
    textures: GPUTexture[],
    output: GPUTexture,
  ): void {
    const device = this.device!
    const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(buffer, 0, new Float32Array([...uniformValues, 0, 0, 0, 0].slice(0, 4)))

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer } },
      { binding: 1, resource: this.sampler! },
    ]
    textures.forEach((texture, i) => entries.push({ binding: 2 + i, resource: texture.createView() }))

    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: output.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(6)
    pass.end()
  }

  private encodeNoUniformPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    input: GPUTexture,
    output: GPUTexture,
  ): void {
    const device = this.device!
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler! },
        { binding: 1, resource: input.createView() },
      ],
    })

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: output.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(6)
    pass.end()
  }

  private encodeAdjustmentStep(
    encoder: GPUCommandEncoder,
    step: AdjustmentStep,
    input: GPUTexture,
    output: GPUTexture,
  ): void {
    switch (step.processor) {
      case 'image.adjustLight': {
        const { exposure, brightness, contrast, blackPoint } = step.params
        this.encodeUniformPass(encoder, this.adjustLightPipeline!, [exposure, brightness, contrast, blackPoint], [input], output)
        return
      }
      case 'image.adjustColor': {
        this.encodeUniformPass(encoder, this.adjustColorPipeline!, [step.params.saturation], [input], output)
        return
      }
      case 'image.blackAndWhite': {
        const { intensity, neutrals, tone } = step.params
        this.encodeUniformPass(encoder, this.blackAndWhitePipeline!, [intensity, neutrals, tone], [input], output)
        return
      }
      case 'image.sharpen': {
        // Three sub-passes: horizontal blur -> vertical blur -> unsharp
        // composite (reads both `input` and the fully-blurred scratch
        // texture). blurScratchA/B are reused across every sharpen step in
        // the recipe -- safe because passes within one render() call are
        // encoded and consumed strictly in order.
        this.encodeNoUniformPass(encoder, this.blurHPipeline!, input, this.blurScratchA!)
        this.encodeNoUniformPass(encoder, this.blurVPipeline!, this.blurScratchA!, this.blurScratchB!)
        this.encodeUniformPass(encoder, this.unsharpPipeline!, [step.params.intensity], [input, this.blurScratchB!], output)
        return
      }
    }
  }

  render(recipe: Recipe): void {
    if (!this.device || !this.context || !this.blitPipeline || !this.blitUniformBuffer || !this.sourceTexture) {
      throw new Error('WebGPURenderer.render() called before init()')
    }

    const encoder = this.device.createCommandEncoder()

    let currentTexture = this.sourceTexture
    let writeToA = true
    for (const step of collectOrderedAdjustmentSteps(recipe)) {
      const output = writeToA ? this.texA! : this.texB!
      this.encodeAdjustmentStep(encoder, step, currentTexture, output)
      currentTexture = output
      writeToA = !writeToA
    }

    const resizeStep = findLastResizeStep(recipe)
    const geometry = resizeStep
      ? computeFitGeometry(this.sourceDimensions, resizeStep.params)
      : {
          outputWidth: this.sourceDimensions.width,
          outputHeight: this.sourceDimensions.height,
          sourceUV: { u0: 0, v0: 0, u1: 1, v1: 1 },
        }

    const canvas = this.context.canvas
    if (canvas instanceof HTMLCanvasElement) {
      canvas.width = Math.max(1, Math.round(geometry.outputWidth))
      canvas.height = Math.max(1, Math.round(geometry.outputHeight))
    }

    this.device.queue.writeBuffer(
      this.blitUniformBuffer,
      0,
      new Float32Array([geometry.sourceUV.u0, geometry.sourceUV.v0, geometry.sourceUV.u1, geometry.sourceUV.v1]),
    )

    const blitBindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.blitUniformBuffer } },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: currentTexture.createView() },
      ],
    })

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(this.blitPipeline)
    pass.setBindGroup(0, blitBindGroup)
    pass.draw(6)
    pass.end()

    this.device.queue.submit([encoder.finish()])
  }

  dispose(): void {
    this.sourceTexture?.destroy()
    this.texA?.destroy()
    this.texB?.destroy()
    this.blurScratchA?.destroy()
    this.blurScratchB?.destroy()
    this.device?.destroy()
    this.device = null
    this.context = null
    this.sampler = null
    this.blitPipeline = null
    this.blitUniformBuffer = null
    this.canvasFormat = null
    this.sourceTexture = null
    this.texA = null
    this.texB = null
    this.blurScratchA = null
    this.blurScratchB = null
    this.adjustLightPipeline = null
    this.adjustColorPipeline = null
    this.blackAndWhitePipeline = null
    this.blurHPipeline = null
    this.blurVPipeline = null
    this.unsharpPipeline = null
  }
}
