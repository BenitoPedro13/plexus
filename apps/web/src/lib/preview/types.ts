import type { Recipe } from '@/lib/recipe/schema'

export type PreviewBackendKind = 'webgpu' | 'webgl2'

// Implemented by WebGPURenderer and WebGL2Renderer. render() is called
// on-demand (whenever `source` or `recipe` changes) rather than on a
// requestAnimationFrame loop -- this is a static-image editor, not video.
export interface PreviewRenderer {
  readonly kind: PreviewBackendKind
  init(canvas: HTMLCanvasElement, source: ImageBitmap): Promise<void>
  render(recipe: Recipe): void
  dispose(): void
}
