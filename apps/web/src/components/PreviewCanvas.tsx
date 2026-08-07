'use client'

import { useEffect, useRef, useState } from 'react'
import type { Recipe } from '@/lib/recipe/schema'
import { detectPreviewBackend } from '@/lib/preview/capabilities'
import type { PreviewBackendKind, PreviewRenderer } from '@/lib/preview/types'
import { WebGL2Renderer } from '@/lib/preview/webgl2-renderer'
import { WebGPURenderer } from '@/lib/preview/webgpu-renderer'

interface PreviewCanvasProps {
  image: ImageBitmap | null
  recipe: Recipe
}

type Status =
  | { state: 'idle' }
  | { state: 'detecting' }
  | { state: 'ready'; backend: PreviewBackendKind }
  | { state: 'unsupported' }
  | { state: 'error'; message: string }

export function PreviewCanvas({ image, recipe }: PreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<PreviewRenderer | null>(null)
  const [status, setStatus] = useState<Status>({ state: 'idle' })

  useEffect(() => {
    if (!image || !canvasRef.current) {
      return
    }

    let cancelled = false
    setStatus({ state: 'detecting' })

    async function setUp() {
      const canvas = canvasRef.current
      if (!canvas || !image) return

      const backend = await detectPreviewBackend()
      if (cancelled) return

      if (backend === 'unsupported') {
        setStatus({ state: 'unsupported' })
        return
      }

      const renderer: PreviewRenderer =
        backend === 'webgpu' ? new WebGPURenderer() : new WebGL2Renderer()

      try {
        await renderer.init(canvas, image)
        if (cancelled) {
          renderer.dispose()
          return
        }
        rendererRef.current = renderer
        renderer.render(recipe)
        setStatus({ state: 'ready', backend })
      } catch (error) {
        renderer.dispose()
        if (!cancelled) {
          setStatus({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    void setUp()

    return () => {
      cancelled = true
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recipe intentionally excluded, handled by the effect below
  }, [image])

  useEffect(() => {
    if (status.state !== 'ready' || !rendererRef.current) {
      return
    }
    rendererRef.current.render(recipe)
  }, [recipe, status.state])

  return (
    <div>
      <canvas ref={canvasRef} />
      <p>
        {status.state === 'idle' && 'Choose an image to preview.'}
        {status.state === 'detecting' && 'Detecting preview backend…'}
        {status.state === 'ready' && `backend: ${status.backend}`}
        {status.state === 'unsupported' &&
          'This browser supports neither WebGPU nor WebGL2 -- no live preview available.'}
        {status.state === 'error' && `Preview error: ${status.message}`}
      </p>
    </div>
  )
}
