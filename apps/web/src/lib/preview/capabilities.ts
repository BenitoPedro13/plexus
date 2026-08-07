import type { PreviewBackendKind } from './types'

// Runtime capability probing, not user-agent/version sniffing (see
// docs/tasks/TASK-preview-renderer.md and docs/90-deferred-register.md V-5):
// `navigator.gpu` can exist while requestAdapter() still fails (blocklisted
// GPU, software-only platform), so its mere presence isn't sufficient
// evidence WebGPU actually works here.
export async function detectPreviewBackend(): Promise<
  PreviewBackendKind | 'unsupported'
> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (adapter) {
        return 'webgpu'
      }
    } catch {
      // fall through to the WebGL2 probe below
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (gl) {
      return 'webgl2'
    }
  }

  return 'unsupported'
}
