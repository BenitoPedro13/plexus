import type { Recipe } from '@/lib/recipe/schema'
import { computeFitGeometry, findLastResizeStep } from './geometry'
import type { PreviewRenderer } from './types'

// Mirrors webgpu-renderer.ts's shader: a full-canvas quad whose local UV is
// mapped through a uniform rect from computeFitGeometry(), so both backends
// crop/scale identically. Same Y-flip approach as the WebGPU shader --
// confirmed against a real headless Chromium run with a top/bottom two-tone
// fixture image (UNPACK_FLIP_Y_WEBGL left false, flip handled by localUV
// instead); not yet cross-checked on Firefox/Safari's WebGL2 implementations.
const VERTEX_SHADER_SOURCE = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aLocalUV;

uniform vec4 uUvRect; // u0, v0, u1, v1

out vec2 vUV;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vUV = mix(uUvRect.xy, uUvRect.zw, aLocalUV);
}
`

const FRAGMENT_SHADER_SOURCE = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uSource;
in vec2 vUV;
out vec4 outColor;

void main() {
  outColor = texture(uSource, vUV);
}
`

// x, y, localU, localV -- two triangles covering clip space, localUV flipped
// on Y to match webgpu-renderer.ts's `localUVs`.
// prettier-ignore
const QUAD_VERTICES = new Float32Array([
  -1, -1, 0, 1,
   1, -1, 1, 1,
  -1,  1, 0, 0,
  -1,  1, 0, 0,
   1, -1, 1, 1,
   1,  1, 1, 0,
])

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('Failed to create WebGL2 shader')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`WebGL2 shader compile failed: ${log ?? 'unknown error'}`)
  }
  return shader
}

export class WebGL2Renderer implements PreviewRenderer {
  readonly kind = 'webgl2' as const

  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private texture: WebGLTexture | null = null
  private vertexBuffer: WebGLBuffer | null = null
  private uvRectLocation: WebGLUniformLocation | null = null
  private canvas: HTMLCanvasElement | null = null
  private sourceDimensions = { width: 0, height: 0 }

  async init(canvas: HTMLCanvasElement, source: ImageBitmap): Promise<void> {
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      throw new Error('Failed to get a webgl2 canvas context')
    }

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE)
    const program = gl.createProgram()
    if (!program) {
      throw new Error('Failed to create WebGL2 program')
    }
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      throw new Error(`WebGL2 program link failed: ${log ?? 'unknown error'}`)
    }
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)

    const vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW)

    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4)

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this.gl = gl
    this.program = program
    this.texture = texture
    this.vertexBuffer = vertexBuffer
    this.uvRectLocation = gl.getUniformLocation(program, 'uUvRect')
    this.canvas = canvas
    this.sourceDimensions = { width: source.width, height: source.height }
  }

  render(recipe: Recipe): void {
    const { gl, program } = this
    if (!gl || !program || !this.canvas) {
      throw new Error('WebGL2Renderer.render() called before init()')
    }

    const resizeStep = findLastResizeStep(recipe)
    const geometry = resizeStep
      ? computeFitGeometry(this.sourceDimensions, resizeStep.params)
      : {
          outputWidth: this.sourceDimensions.width,
          outputHeight: this.sourceDimensions.height,
          sourceUV: { u0: 0, v0: 0, u1: 1, v1: 1 },
        }

    this.canvas.width = Math.max(1, Math.round(geometry.outputWidth))
    this.canvas.height = Math.max(1, Math.round(geometry.outputHeight))
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)

    gl.useProgram(program)
    gl.uniform4f(
      this.uvRectLocation,
      geometry.sourceUV.u0,
      geometry.sourceUV.v0,
      geometry.sourceUV.u1,
      geometry.sourceUV.v1,
    )
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  dispose(): void {
    if (this.gl) {
      if (this.program) this.gl.deleteProgram(this.program)
      if (this.texture) this.gl.deleteTexture(this.texture)
      if (this.vertexBuffer) this.gl.deleteBuffer(this.vertexBuffer)
    }
    this.gl = null
    this.program = null
    this.texture = null
    this.vertexBuffer = null
    this.uvRectLocation = null
    this.canvas = null
  }
}
