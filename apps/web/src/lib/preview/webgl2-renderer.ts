import type { Recipe } from '@/lib/recipe/schema'
import { collectOrderedAdjustmentSteps, gaussianKernel1D, type AdjustmentStep } from './color-math'
import { computeFitGeometry, findLastResizeStep } from './geometry'
import type { PreviewRenderer } from './types'

// Radius=2 (5-tap) at the Go processor's fixed sigma=0.5
// (workers/internal/processors/sharpen.go) covers >99% of the kernel's
// mass. Computed once here (color-math.ts is the single source of truth,
// same constant webgpu-renderer.ts inlines into WGSL) and inlined as GLSL
// literals below.
const GAUSSIAN_RADIUS = 2
const GAUSSIAN_WEIGHTS = gaussianKernel1D(0.5, GAUSSIAN_RADIUS)

// Mirrors webgpu-renderer.ts's BLIT_SHADER_SOURCE: a full-canvas quad whose
// local UV is mapped through a uniform rect from computeFitGeometry(), so
// both backends crop/scale identically. Same Y-flip approach as the WebGPU
// shader -- confirmed against a real headless Chromium run with a
// top/bottom two-tone fixture image (UNPACK_FLIP_Y_WEBGL left false, flip
// handled by localUV instead); not yet cross-checked on Firefox/Safari's
// WebGL2 implementations. Used only for the *final* blit into the visible
// canvas -- content-adjustment passes below use CONTENT_VERTEX_SHADER
// (no crop, 1:1 with the source image's own dimensions).
const BLIT_VERTEX_SHADER_SOURCE = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aLocalUV;

uniform vec4 uUvRect; // u0, v0, u1, v1

out vec2 vUV;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vUV = mix(uUvRect.xy, uUvRect.zw, aLocalUV);
}
`

const BLIT_FRAGMENT_SHADER_SOURCE = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uSource;
in vec2 vUV;
out vec4 outColor;

void main() {
  outColor = texture(uSource, vUV);
}
`

// Shared vertex stage for every content-adjustment pass: same attribute
// layout as the blit vertex shader (so both share one VAO/vertex buffer),
// but UV is passed through unmodified -- these passes run elementwise
// against off-screen textures sized to the *source* image's dimensions,
// before geometry's crop/scale (D-21, docs/90-deferred-register.md).
const CONTENT_VERTEX_SHADER_SOURCE = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aLocalUV;

out vec2 vUV;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vUV = aLocalUV;
}
`

// Mirrors color-math.ts's rgbToLab/labToRgb -- see that file's comments for
// the V-11 caveat on Modulate's exact white point.
const LAB_HELPERS_GLSL = /* glsl */ `
float srgbToLinearChannel(float c) {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}

float linearToSrgbChannel(float c) {
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

const float LAB_EPSILON = 0.0088564517; // (6/29)^3
const float LAB_KAPPA = 7.787037; // 1 / (3*(6/29)^2)

float labF(float t) {
  if (t > LAB_EPSILON) { return pow(t, 1.0 / 3.0); }
  return LAB_KAPPA * t + 4.0 / 29.0;
}

float labFInverse(float t) {
  float t3 = t * t * t;
  if (t3 > LAB_EPSILON) { return t3; }
  return (t - 4.0 / 29.0) / LAB_KAPPA;
}

vec3 rgbToLab(vec3 rgb) {
  float lr = srgbToLinearChannel(rgb.r);
  float lg = srgbToLinearChannel(rgb.g);
  float lb = srgbToLinearChannel(rgb.b);
  float x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  float y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
  float z = 0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb;
  float fx = labF(x / 0.95047);
  float fy = labF(y / 1.0);
  float fz = labF(z / 1.08883);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

vec3 labToRgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  float fx = fy + lab.y / 500.0;
  float fz = fy - lab.z / 200.0;
  float x = 0.95047 * labFInverse(fx);
  float y = 1.0 * labFInverse(fy);
  float z = 1.08883 * labFInverse(fz);
  float lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  float lg = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  float lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return clamp(
    vec3(linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb)),
    vec3(0.0),
    vec3(1.0)
  );
}
`

// Mirrors color-math.ts's applyAdjustLight -- uParams: exposure,
// brightness, contrast, blackPoint. RGB only; alpha passed through
// unchanged (D-20, docs/90-deferred-register.md).
const ADJUST_LIGHT_FRAGMENT_SHADER_SOURCE = /* glsl */ `#version 300 es
precision highp float;

uniform vec4 uParams;
uniform sampler2D uSource;
in vec2 vUV;
out vec4 outColor;

float adjustLightChannel(float c) {
  float exposure = uParams.x;
  float brightness = uParams.y;
  float contrast = uParams.z;
  float blackPoint = uParams.w;
  float denom = max(1.0 - blackPoint, 1e-6);
  float x = c * pow(2.0, exposure);
  x = x + brightness;
  x = x * (1.0 + contrast) - 0.5 * contrast;
  x = (x - blackPoint) / denom;
  return clamp(x, 0.0, 1.0);
}

void main() {
  vec4 c = texture(uSource, vUV);
  outColor = vec4(adjustLightChannel(c.r), adjustLightChannel(c.g), adjustLightChannel(c.b), c.a);
}
`

// Mirrors color-math.ts's applyAdjustColor -- img.Modulate(1, 1+saturation,
// 0): convert to LCh, scale chroma, convert back. uParams.x = saturation.
const ADJUST_COLOR_FRAGMENT_SHADER_SOURCE =
  /* glsl */ `#version 300 es
precision highp float;

uniform vec4 uParams;
uniform sampler2D uSource;
in vec2 vUV;
out vec4 outColor;
` +
  LAB_HELPERS_GLSL +
  /* glsl */ `
const float CHROMA_EPSILON = 1e-4;

void main() {
  vec4 c = texture(uSource, vUV);
  vec3 lab = rgbToLab(c.rgb);
  float chroma = length(vec2(lab.y, lab.z));
  float scaledChroma = max(0.0, chroma * (1.0 + uParams.x));
  vec2 newAB = vec2(0.0, 0.0);
  if (chroma > CHROMA_EPSILON) {
    // atan(y, x) is undefined at (0, 0) per the GLSL ES spec -- guard so
    // achromatic pixels never take this path.
    float hue = atan(lab.z, lab.y);
    newAB = vec2(scaledChroma * cos(hue), scaledChroma * sin(hue));
  }
  vec3 newLab = vec3(lab.x, newAB.x, newAB.y);
  outColor = vec4(labToRgb(newLab), c.a);
}
`

// Mirrors color-math.ts's applyBlackAndWhite -- uParams: intensity,
// neutrals, tone.
const BLACK_AND_WHITE_FRAGMENT_SHADER_SOURCE = /* glsl */ `#version 300 es
precision highp float;

uniform vec4 uParams;
uniform sampler2D uSource;
in vec2 vUV;
out vec4 outColor;

void main() {
  vec4 c = texture(uSource, vUV);
  float intensity = uParams.x;
  float neutrals = uParams.y;
  float tone = uParams.z;
  float green = 1.0 / 3.0 + neutrals / 3.0;
  float redBlue = (1.0 - green) / 2.0;
  float gray = redBlue * c.r + green * c.g + redBlue * c.b;
  float toned = gray * (1.0 + tone) - 0.5 * tone;
  vec3 mixed = clamp(mix(c.rgb, vec3(toned), intensity), vec3(0.0), vec3(1.0));
  outColor = vec4(mixed, c.a);
}
`

function blurWeightsGLSL(): string {
  return GAUSSIAN_WEIGHTS.map((w) => w.toFixed(8)).join(', ')
}

// Separable Gaussian blur, sigma fixed at 0.5 (matches
// workers/internal/processors/sharpen.go's img.Sharpen(0.5, 2, ...)). No
// uniform params -- weights are compile-time constants, direction baked
// per-shader.
function blurFragmentShaderSource(direction: 'horizontal' | 'vertical'): string {
  const texelOffset = direction === 'horizontal' ? 'vec2(1.0 / dims.x, 0.0)' : 'vec2(0.0, 1.0 / dims.y)'
  return /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uSource;
in vec2 vUV;
out vec4 outColor;

const int RADIUS = ${GAUSSIAN_RADIUS};
const float weights[${GAUSSIAN_WEIGHTS.length}] = float[${GAUSSIAN_WEIGHTS.length}](${blurWeightsGLSL()});

void main() {
  vec2 dims = vec2(textureSize(uSource, 0));
  vec2 texel = ${texelOffset};
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${GAUSSIAN_WEIGHTS.length}; i++) {
    float offset = float(i - RADIUS);
    sum += texture(uSource, vUV + texel * offset) * weights[i];
  }
  outColor = sum;
}
`
}

// Unsharp-mask composite: reads the pre-blur ("original") and blurred
// textures, sharpens the Lab L channel only (V-10, color-math.ts's
// applyUnsharpMask default). uParams.x = intensity.
//
// Piecewise flat/jaggy response, mirrors color-math.ts's sharpenResponse:
// x1=2 (flat/jaggy threshold), y2=10 (max brighten), y3=20 (max darken),
// m1=0 -- libvips' own defaults for the SharpenOptions fields govips'
// Sharpen(sigma, x1, m2) leaves unset (image_pixel.go, v2.18.0). |diff| <=
// x1 gets zero response (flat/noise areas); only real edges (|diff| > x1)
// get slope m2.
const UNSHARP_FRAGMENT_SHADER_SOURCE =
  /* glsl */ `#version 300 es
precision highp float;

const float SHARPEN_X1 = 2.0;
const float SHARPEN_Y2 = 10.0;
const float SHARPEN_Y3 = 20.0;

uniform vec4 uParams;
uniform sampler2D uOriginal;
uniform sampler2D uBlurred;
in vec2 vUV;
out vec4 outColor;
` +
  LAB_HELPERS_GLSL +
  /* glsl */ `
void main() {
  vec4 orig = texture(uOriginal, vUV);
  vec4 blurred = texture(uBlurred, vUV);
  float m2 = 3.0 * uParams.x;
  vec3 origLab = rgbToLab(orig.rgb);
  vec3 blurredLab = rgbToLab(blurred.rgb);
  float diff = origLab.x - blurredLab.x;
  float slope = abs(diff) > SHARPEN_X1 ? m2 : 0.0;
  float y = clamp(slope * diff, -SHARPEN_Y3, SHARPEN_Y2);
  float sharpenedL = origLab.x + y;
  outColor = vec4(labToRgb(vec3(sharpenedL, origLab.y, origLab.z)), orig.a);
}
`

// x, y, localU, localV -- two triangles covering clip space, localUV flipped
// on Y to match webgpu-renderer.ts's `localUVs`. Shared by every program
// (blit and content) -- all vertex shaders use the same attribute layout.
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

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
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
  return program
}

function createRenderTargetTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) {
    throw new Error('Failed to create WebGL2 render-target texture')
  }
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

function createFramebuffer(gl: WebGL2RenderingContext, texture: WebGLTexture): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer()
  if (!framebuffer) {
    throw new Error('Failed to create WebGL2 framebuffer')
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`WebGL2 framebuffer incomplete: 0x${status.toString(16)}`)
  }
  return framebuffer
}

interface ContentProgram {
  program: WebGLProgram
  paramsLocation: WebGLUniformLocation | null
  textureLocations: (WebGLUniformLocation | null)[]
}

export class WebGL2Renderer implements PreviewRenderer {
  readonly kind = 'webgl2' as const

  private gl: WebGL2RenderingContext | null = null
  private canvas: HTMLCanvasElement | null = null
  private vertexBuffer: WebGLBuffer | null = null

  private blitProgram: WebGLProgram | null = null
  private blitUvRectLocation: WebGLUniformLocation | null = null

  private sourceTexture: WebGLTexture | null = null
  private texA: WebGLTexture | null = null
  private texB: WebGLTexture | null = null
  private blurScratchA: WebGLTexture | null = null
  private blurScratchB: WebGLTexture | null = null
  private fboA: WebGLFramebuffer | null = null
  private fboB: WebGLFramebuffer | null = null
  private blurFboA: WebGLFramebuffer | null = null
  private blurFboB: WebGLFramebuffer | null = null

  private adjustLight: ContentProgram | null = null
  private adjustColor: ContentProgram | null = null
  private blackAndWhite: ContentProgram | null = null
  private blurH: ContentProgram | null = null
  private blurV: ContentProgram | null = null
  private unsharp: ContentProgram | null = null

  private sourceDimensions = { width: 0, height: 0 }

  async init(canvas: HTMLCanvasElement, source: ImageBitmap): Promise<void> {
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      throw new Error('Failed to get a webgl2 canvas context')
    }

    const vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW)

    const bindQuadAttributes = (): void => {
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4)
    }
    bindQuadAttributes()

    const sourceTexture = gl.createTexture()
    if (!sourceTexture) {
      throw new Error('Failed to create WebGL2 source texture')
    }
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const { width, height } = source
    const texA = createRenderTargetTexture(gl, width, height)
    const texB = createRenderTargetTexture(gl, width, height)
    const blurScratchA = createRenderTargetTexture(gl, width, height)
    const blurScratchB = createRenderTargetTexture(gl, width, height)
    const fboA = createFramebuffer(gl, texA)
    const fboB = createFramebuffer(gl, texB)
    const blurFboA = createFramebuffer(gl, blurScratchA)
    const blurFboB = createFramebuffer(gl, blurScratchB)

    const blitProgram = createProgram(gl, BLIT_VERTEX_SHADER_SOURCE, BLIT_FRAGMENT_SHADER_SOURCE)

    const buildContentProgram = (fragmentSource: string, textureUniformNames: string[]): ContentProgram => {
      const program = createProgram(gl, CONTENT_VERTEX_SHADER_SOURCE, fragmentSource)
      return {
        program,
        paramsLocation: gl.getUniformLocation(program, 'uParams'),
        textureLocations: textureUniformNames.map((name) => gl.getUniformLocation(program, name)),
      }
    }

    this.gl = gl
    this.canvas = canvas
    this.vertexBuffer = vertexBuffer
    this.blitProgram = blitProgram
    this.blitUvRectLocation = gl.getUniformLocation(blitProgram, 'uUvRect')
    this.sourceTexture = sourceTexture
    this.texA = texA
    this.texB = texB
    this.blurScratchA = blurScratchA
    this.blurScratchB = blurScratchB
    this.fboA = fboA
    this.fboB = fboB
    this.blurFboA = blurFboA
    this.blurFboB = blurFboB
    this.adjustLight = buildContentProgram(ADJUST_LIGHT_FRAGMENT_SHADER_SOURCE, ['uSource'])
    this.adjustColor = buildContentProgram(ADJUST_COLOR_FRAGMENT_SHADER_SOURCE, ['uSource'])
    this.blackAndWhite = buildContentProgram(BLACK_AND_WHITE_FRAGMENT_SHADER_SOURCE, ['uSource'])
    this.blurH = buildContentProgram(blurFragmentShaderSource('horizontal'), ['uSource'])
    this.blurV = buildContentProgram(blurFragmentShaderSource('vertical'), ['uSource'])
    this.unsharp = buildContentProgram(UNSHARP_FRAGMENT_SHADER_SOURCE, ['uOriginal', 'uBlurred'])
    this.sourceDimensions = { width, height }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private runContentPass(
    target: ContentProgram,
    uniformValues: number[] | null,
    textures: WebGLTexture[],
    outputFbo: WebGLFramebuffer,
  ): void {
    const gl = this.gl!
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo)
    gl.viewport(0, 0, this.sourceDimensions.width, this.sourceDimensions.height)
    gl.useProgram(target.program)

    if (uniformValues) {
      const [x = 0, y = 0, z = 0, w = 0] = uniformValues
      gl.uniform4f(target.paramsLocation, x, y, z, w)
    }

    textures.forEach((texture, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(target.textureLocations[i], i)
    })

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  private runAdjustmentStep(step: AdjustmentStep, input: WebGLTexture, outputFbo: WebGLFramebuffer): void {
    switch (step.processor) {
      case 'image.adjustLight': {
        const { exposure, brightness, contrast, blackPoint } = step.params
        this.runContentPass(this.adjustLight!, [exposure, brightness, contrast, blackPoint], [input], outputFbo)
        return
      }
      case 'image.adjustColor': {
        this.runContentPass(this.adjustColor!, [step.params.saturation], [input], outputFbo)
        return
      }
      case 'image.blackAndWhite': {
        const { intensity, neutrals, tone } = step.params
        this.runContentPass(this.blackAndWhite!, [intensity, neutrals, tone], [input], outputFbo)
        return
      }
      case 'image.sharpen': {
        // Three sub-passes: horizontal blur -> vertical blur -> unsharp
        // composite. blurScratchA/B are reused across every sharpen step
        // in the recipe -- safe because WebGL2 is a synchronous state
        // machine, each draw call fully executes (from the API's point of
        // view) before the next is issued.
        this.runContentPass(this.blurH!, null, [input], this.blurFboA!)
        this.runContentPass(this.blurV!, null, [this.blurScratchA!], this.blurFboB!)
        this.runContentPass(this.unsharp!, [step.params.intensity], [input, this.blurScratchB!], outputFbo)
        return
      }
    }
  }

  render(recipe: Recipe): void {
    const { gl } = this
    if (!gl || !this.blitProgram || !this.canvas || !this.sourceTexture) {
      throw new Error('WebGL2Renderer.render() called before init()')
    }

    let currentTexture = this.sourceTexture
    let writeToA = true
    for (const step of collectOrderedAdjustmentSteps(recipe)) {
      const outputTexture = writeToA ? this.texA! : this.texB!
      const outputFbo = writeToA ? this.fboA! : this.fboB!
      this.runAdjustmentStep(step, currentTexture, outputFbo)
      currentTexture = outputTexture
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

    this.canvas.width = Math.max(1, Math.round(geometry.outputWidth))
    this.canvas.height = Math.max(1, Math.round(geometry.outputHeight))

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(this.blitProgram)
    gl.uniform4f(
      this.blitUvRectLocation,
      geometry.sourceUV.u0,
      geometry.sourceUV.v0,
      geometry.sourceUV.u1,
      geometry.sourceUV.v1,
    )
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, currentTexture)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  dispose(): void {
    if (this.gl) {
      const gl = this.gl
      ;[this.blitProgram, this.adjustLight?.program, this.adjustColor?.program, this.blackAndWhite?.program, this.blurH?.program, this.blurV?.program, this.unsharp?.program].forEach(
        (program) => {
          if (program) gl.deleteProgram(program)
        },
      )
      ;[this.sourceTexture, this.texA, this.texB, this.blurScratchA, this.blurScratchB].forEach((texture) => {
        if (texture) gl.deleteTexture(texture)
      })
      ;[this.fboA, this.fboB, this.blurFboA, this.blurFboB].forEach((fbo) => {
        if (fbo) gl.deleteFramebuffer(fbo)
      })
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer)
    }
    this.gl = null
    this.canvas = null
    this.vertexBuffer = null
    this.blitProgram = null
    this.blitUvRectLocation = null
    this.sourceTexture = null
    this.texA = null
    this.texB = null
    this.blurScratchA = null
    this.blurScratchB = null
    this.fboA = null
    this.fboB = null
    this.blurFboA = null
    this.blurFboB = null
    this.adjustLight = null
    this.adjustColor = null
    this.blackAndWhite = null
    this.blurH = null
    this.blurV = null
    this.unsharp = null
  }
}
