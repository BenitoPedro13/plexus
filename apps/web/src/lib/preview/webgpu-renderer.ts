/// <reference types="@webgpu/types" />
import type { Recipe } from '@/lib/recipe/schema'
import { computeFitGeometry, findLastResizeStep } from './geometry'
import type { PreviewRenderer } from './types'

// Vertex shader emits a full-canvas quad (two triangles, NDC -1..1) and maps
// each vertex's local UV through a uniform rect produced by
// computeFitGeometry() -- the same rect the WebGL2 renderer consumes, so
// both backends crop/scale identically. localUVs' Y is flipped relative to
// NDC Y (NDC +1 = top of clip space) so v=0 lands on the source image's top
// row -- confirmed against a real headless Chromium (--enable-unsafe-webgpu)
// run with a top/bottom two-tone fixture image, top stayed on top after
// copyExternalImageToTexture() from an ImageBitmap; not yet cross-checked on
// Firefox/Safari's WebGPU implementations.
const SHADER_SOURCE = /* wgsl */ `
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

export class WebGPURenderer implements PreviewRenderer {
  readonly kind = 'webgpu' as const

  private device: GPUDevice | null = null
  private context: GPUCanvasContext | null = null
  private pipeline: GPURenderPipeline | null = null
  private bindGroup: GPUBindGroup | null = null
  private uniformBuffer: GPUBuffer | null = null
  private canvasFormat: GPUTextureFormat | null = null
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

    const texture = device.createTexture({
      size: [source.width, source.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture(
      { source },
      { texture },
      [source.width, source.height],
    )

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })

    const uniformBuffer = device.createBuffer({
      size: 16, // vec4f: u0, v0, u1, v1
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const shaderModule = device.createShaderModule({ code: SHADER_SOURCE })
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vertex_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: 'triangle-list' },
    })

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: texture.createView() },
      ],
    })

    this.device = device
    this.context = context
    this.pipeline = pipeline
    this.bindGroup = bindGroup
    this.uniformBuffer = uniformBuffer
    this.canvasFormat = canvasFormat
    this.sourceDimensions = { width: source.width, height: source.height }
  }

  render(recipe: Recipe): void {
    if (!this.device || !this.context || !this.pipeline || !this.bindGroup || !this.uniformBuffer) {
      throw new Error('WebGPURenderer.render() called before init()')
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
      this.uniformBuffer,
      0,
      new Float32Array([
        geometry.sourceUV.u0,
        geometry.sourceUV.v0,
        geometry.sourceUV.u1,
        geometry.sourceUV.v1,
      ]),
    )

    const encoder = this.device.createCommandEncoder()
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
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(6)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  dispose(): void {
    this.device?.destroy()
    this.device = null
    this.context = null
    this.pipeline = null
    this.bindGroup = null
    this.uniformBuffer = null
    this.canvasFormat = null
  }
}
