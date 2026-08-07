'use client'

import { useState } from 'react'
import { PreviewCanvas } from '@/components/PreviewCanvas'
import type { Recipe } from '@/lib/recipe/schema'

// Deliberately unstyled, not the real editor UI -- see
// docs/tasks/TASK-preview-renderer.md. Proves the WebGPU/WebGL2 dual-path
// renderer actually runs in a browser; the curated composite-slider UI
// (docs/90-deferred-register.md D-6) is still undesigned.
export default function PreviewDemoPage() {
  const [image, setImage] = useState<ImageBitmap | null>(null)
  const [width, setWidth] = useState(400)
  const [height, setHeight] = useState(400)
  const [fit, setFit] = useState<'inside' | 'cover'>('inside')

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const bitmap = await createImageBitmap(file)
    setImage(bitmap)
  }

  const recipe: Recipe = {
    steps: [
      {
        id: 'preview-resize',
        processor: 'image.resize',
        params: { width, height, fit },
      },
    ],
  }

  return (
    <main>
      <h1>Preview renderer demo</h1>
      <p>
        <input type="file" accept="image/*" onChange={handleFileChange} />
      </p>
      <p>
        <label>
          width
          <input
            type="number"
            min={1}
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
          />
        </label>
        <label>
          height
          <input
            type="number"
            min={1}
            value={height}
            onChange={(event) => setHeight(Number(event.target.value))}
          />
        </label>
        <label>
          fit
          <select
            value={fit}
            onChange={(event) => setFit(event.target.value as 'inside' | 'cover')}
          >
            <option value="inside">inside</option>
            <option value="cover">cover</option>
          </select>
        </label>
      </p>
      <PreviewCanvas image={image} recipe={recipe} />
    </main>
  )
}
