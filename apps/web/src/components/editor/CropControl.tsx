'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { dragRectToCropParams, type DragRect } from '@/lib/editor/crop-drag'
import type { CropParams } from '@/lib/recipe/schema'

interface CropControlProps {
  image: ImageBitmap | null
  value: CropParams | null
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  onChange: (next: CropParams) => void
  onCommit: () => void
}

// Fixed display box for the crop tool's own canvas -- large enough to drag
// against comfortably, small enough to sit in the same 320px-wide aside as
// every other control.
const MAX_DISPLAY_WIDTH = 280
const MAX_DISPLAY_HEIGHT = 280

const RECT_STROKE = '#3b82f6'
const RECT_FILL = 'rgba(59, 130, 246, 0.15)'

// A self-contained crop-selection tool, deliberately NOT layered on top of
// PreviewCanvas's live WebGPU/WebGL canvas -- that canvas always shows the
// *composed* crop+resize geometry (computeGeometryChain), a coordinate frame
// that shifts with the current `fit` mode and any already-committed crop.
// Drawing straight from the untouched ImageBitmap here means a drag is
// always in original-source-fraction space, exactly what crop.go (and this
// editor's crop-first recipe order) expects -- see
// docs/tasks/TASK-crop-preview-parity.md "Porquê". Resizable handles on an
// already-drawn rect, aspect-ratio lock/presets, and rotation are explicitly
// out of scope here (each drag redefines the rect from scratch) -- tracked
// as a new D-xx in docs/90-deferred-register.md.
export function CropControl({ image, value, enabled, onEnabledChange, onChange, onCommit }: CropControlProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drag, setDrag] = useState<DragRect | null>(null)

  const displaySize = useMemo(() => {
    if (!image) return { width: 0, height: 0 }
    const scale = Math.min(MAX_DISPLAY_WIDTH / image.width, MAX_DISPLAY_HEIGHT / image.height)
    return {
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
    }
  }, [image])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || displaySize.width === 0) return

    canvas.width = displaySize.width
    canvas.height = displaySize.height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

    const rect = drag ?? (value ? cropParamsToDisplayRect(value, displaySize) : null)
    if (rect) {
      const left = Math.min(rect.x0, rect.x1)
      const top = Math.min(rect.y0, rect.y1)
      const width = Math.abs(rect.x1 - rect.x0)
      const height = Math.abs(rect.y1 - rect.y0)
      ctx.fillStyle = RECT_FILL
      ctx.fillRect(left, top, width, height)
      ctx.strokeStyle = RECT_STROKE
      ctx.lineWidth = 2
      ctx.strokeRect(left, top, width, height)
    }
  }, [image, displaySize, drag, value])

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!enabled) return
    const { x, y } = pointerToCanvasPoint(event)
    setDrag({ x0: x, y0: y, x1: x, y1: y })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!enabled || !drag) return
    const { x, y } = pointerToCanvasPoint(event)
    setDrag({ ...drag, x1: x, y1: y })
  }

  function handlePointerUp() {
    if (!enabled || !drag) return
    const params = dragRectToCropParams(drag, displaySize)
    setDrag(null)
    if (params) {
      onChange(params)
      onCommit()
    }
  }

  function pointerToCanvasPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  return (
    <fieldset>
      <legend>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!image}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          Crop
        </label>
      </legend>
      {!image && <p>Choose an image to enable crop.</p>}
      {image && (
        <canvas
          ref={canvasRef}
          style={{ cursor: enabled ? 'crosshair' : 'default', touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
    </fieldset>
  )
}

function cropParamsToDisplayRect(
  value: CropParams,
  displaySize: { width: number; height: number },
): DragRect {
  return {
    x0: value.x * displaySize.width,
    y0: value.y * displaySize.height,
    x1: (value.x + value.width) * displaySize.width,
    y1: (value.y + value.height) * displaySize.height,
  }
}
