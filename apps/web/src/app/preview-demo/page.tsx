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

  // Composite-slider controls (TASK-composite-preview-shaders.md) --
  // identity-valued by default so leaving them untouched reproduces the
  // pre-existing resize-only preview exactly.
  const [exposure, setExposure] = useState(0)
  const [brightness, setBrightness] = useState(0)
  const [contrast, setContrast] = useState(0)
  const [blackPoint, setBlackPoint] = useState(0)
  const [saturation, setSaturation] = useState(0)
  const [castStrength, setCastStrength] = useState(0)
  const [bwIntensity, setBwIntensity] = useState(0)
  const [neutrals, setNeutrals] = useState(0)
  const [tone, setTone] = useState(0)
  const [sharpenIntensity, setSharpenIntensity] = useState(0)

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
      {
        id: 'preview-adjust-light',
        processor: 'image.adjustLight',
        params: { exposure, brightness, contrast, blackPoint, highlights: 0, shadows: 0 },
      },
      {
        id: 'preview-adjust-color',
        processor: 'image.adjustColor',
        params: { saturation, castStrength },
      },
      {
        id: 'preview-black-and-white',
        processor: 'image.blackAndWhite',
        params: { intensity: bwIntensity, neutrals, tone },
      },
      {
        id: 'preview-sharpen',
        processor: 'image.sharpen',
        params: { intensity: sharpenIntensity },
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
      <fieldset>
        <legend>Light</legend>
        <label>
          exposure ({exposure.toFixed(2)})
          <input type="range" min={-3} max={3} step={0.05} value={exposure} onChange={(e) => setExposure(Number(e.target.value))} />
        </label>
        <label>
          brightness ({brightness.toFixed(2)})
          <input type="range" min={-1} max={1} step={0.05} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
        </label>
        <label>
          contrast ({contrast.toFixed(2)})
          <input type="range" min={-1} max={1} step={0.05} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} />
        </label>
        <label>
          blackPoint ({blackPoint.toFixed(2)})
          <input type="range" min={0} max={1} step={0.05} value={blackPoint} onChange={(e) => setBlackPoint(Number(e.target.value))} />
        </label>
      </fieldset>
      <fieldset>
        <legend>Color</legend>
        <label>
          saturation ({saturation.toFixed(2)})
          <input type="range" min={-1} max={1} step={0.05} value={saturation} onChange={(e) => setSaturation(Number(e.target.value))} />
        </label>
        <label>
          castStrength ({castStrength.toFixed(2)})
          <input type="range" min={0} max={1} step={0.05} value={castStrength} onChange={(e) => setCastStrength(Number(e.target.value))} />
        </label>
      </fieldset>
      <fieldset>
        <legend>B&amp;W</legend>
        <label>
          intensity ({bwIntensity.toFixed(2)})
          <input type="range" min={0} max={1} step={0.05} value={bwIntensity} onChange={(e) => setBwIntensity(Number(e.target.value))} />
        </label>
        <label>
          neutrals ({neutrals.toFixed(2)})
          <input type="range" min={-1} max={1} step={0.05} value={neutrals} onChange={(e) => setNeutrals(Number(e.target.value))} />
        </label>
        <label>
          tone ({tone.toFixed(2)})
          <input type="range" min={-1} max={1} step={0.05} value={tone} onChange={(e) => setTone(Number(e.target.value))} />
        </label>
      </fieldset>
      <fieldset>
        <legend>Sharpen</legend>
        <label>
          intensity ({sharpenIntensity.toFixed(2)})
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sharpenIntensity}
            onChange={(e) => setSharpenIntensity(Number(e.target.value))}
          />
        </label>
      </fieldset>
      <PreviewCanvas image={image} recipe={recipe} />
    </main>
  )
}
