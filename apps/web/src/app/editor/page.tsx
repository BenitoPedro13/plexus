'use client'

import { useEffect, useState } from 'react'
import { BlackAndWhiteControl } from '@/components/editor/BlackAndWhiteControl'
import { ColorControl } from '@/components/editor/ColorControl'
import { CropControl } from '@/components/editor/CropControl'
import { LightControl } from '@/components/editor/LightControl'
import { SharpenControl } from '@/components/editor/SharpenControl'
import { PreviewCanvas } from '@/components/PreviewCanvas'
import { useRecipeHistory } from '@/lib/editor/history'
import { exportRecipe, triggerDownload } from '@/lib/editor/export'
import { identityLightParams } from '@/lib/editor/light-blend'
import type { AdjustColorParams, AdjustLightParams, BlackAndWhiteParams, CropParams, Recipe } from '@/lib/recipe/schema'

interface EditState {
  width: number
  height: number
  fit: 'inside' | 'cover'
  cropEnabled: boolean
  crop: CropParams | null
  light: AdjustLightParams
  color: AdjustColorParams
  bwEnabled: boolean
  bw: BlackAndWhiteParams
  sharpenIntensity: number
}

const identityBwParams: BlackAndWhiteParams = { intensity: 0, neutrals: 0, tone: 0, grain: 0 }
const identityColorParams: AdjustColorParams = { saturation: 0, castStrength: 0 }

const initialEditState: EditState = {
  width: 400,
  height: 400,
  fit: 'inside',
  cropEnabled: false,
  crop: null,
  light: identityLightParams,
  color: identityColorParams,
  bwEnabled: false,
  bw: identityBwParams,
  sharpenIntensity: 0,
}

// Only emits a composite step when it differs from identity (B&W: when
// enabled at all) -- keeps hand-edited recipes minimal instead of a fixed
// five-step stack of mostly no-ops, per docs/tasks/TASK-editor-composite-ui.md.
// crop, when enabled and a rect has actually been drawn, is emitted
// *before* resize -- "select a region of the original, then thumbnail-fit
// that region" -- see docs/tasks/TASK-crop-preview-parity.md "Porquê" for
// why this recipe order is also what makes computeGeometryChain's
// order-sensitivity load-bearing. Disabling the tool (cropEnabled = false)
// stops emitting the step without discarding the drawn rect, same
// enabled/value split BlackAndWhiteControl already uses -- re-enabling
// shows the previous selection again rather than forcing a redraw.
function deriveRecipe(state: EditState): Recipe {
  const steps: Recipe['steps'] = []

  if (state.cropEnabled && state.crop) {
    steps.push({ id: 'crop', processor: 'image.crop', params: state.crop })
  }

  steps.push({
    id: 'resize',
    processor: 'image.resize',
    params: { width: state.width, height: state.height, fit: state.fit },
  })

  const { light } = state
  if (
    light.exposure !== 0 ||
    light.brightness !== 0 ||
    light.contrast !== 0 ||
    light.blackPoint !== 0 ||
    light.highlights !== 0 ||
    light.shadows !== 0
  ) {
    steps.push({ id: 'light', processor: 'image.adjustLight', params: light })
  }

  if (state.color.saturation !== 0 || state.color.castStrength !== 0) {
    steps.push({ id: 'color', processor: 'image.adjustColor', params: state.color })
  }

  if (state.bwEnabled) {
    steps.push({ id: 'bw', processor: 'image.blackAndWhite', params: state.bw })
  }

  if (state.sharpenIntensity !== 0) {
    steps.push({
      id: 'sharpen',
      processor: 'image.sharpen',
      params: { intensity: state.sharpenIntensity },
    })
  }

  return { steps }
}

// The real editor route -- curated Light/Color/B&W/Sharpen controls plus
// undo/redo, per the spec's P0 editor bullets. apps/web/src/app/preview-demo
// remains the renderer smoke-test harness (raw params, no history); this
// page is the primary surface. See docs/tasks/TASK-editor-composite-ui.md.
export default function EditorPage() {
  const [image, setImage] = useState<ImageBitmap | null>(null)
  // The original uploaded File, kept alongside the decoded ImageBitmap
  // used for live preview -- export needs the untouched original bytes
  // (workers/cmd/renderserver's processors read a real image file, not a
  // canvas re-encode), see docs/tasks/TASK-editor-export.md.
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const history = useRecipeHistory<EditState>(initialEditState)
  const live = history.present

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isModifier = event.metaKey || event.ctrlKey
      if (!isModifier || event.key.toLowerCase() !== 'z') return
      event.preventDefault()
      if (event.shiftKey) {
        history.redo()
      } else {
        history.undo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [history])

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const bitmap = await createImageBitmap(file)
    setImage(bitmap)
    setSourceFile(file)
    setExportError(null)
  }

  const recipe = deriveRecipe(live)

  async function handleExport() {
    if (!sourceFile) return
    setIsExporting(true)
    setExportError(null)
    try {
      const blob = await exportRecipe(sourceFile, recipe)
      const baseName = sourceFile.name.replace(/\.[^./]+$/, '') || 'export'
      triggerDownload(blob, baseName)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <main style={{ display: 'flex', gap: '2rem', padding: '1.5rem', alignItems: 'flex-start' }}>
      <section style={{ flex: 1 }}>
        <h1>Editor</h1>
        <p>
          <input type="file" accept="image/*" onChange={handleFileChange} />
        </p>
        <PreviewCanvas image={image} recipe={recipe} />
      </section>
      <aside style={{ width: 320, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <button type="button" onClick={history.undo} disabled={!history.canUndo}>
            Undo
          </button>{' '}
          <button type="button" onClick={history.redo} disabled={!history.canRedo}>
            Redo
          </button>{' '}
          <button type="button" onClick={handleExport} disabled={!sourceFile || isExporting}>
            {isExporting ? 'Exporting…' : 'Export'}
          </button>
          {exportError && <p style={{ color: 'crimson' }}>{exportError}</p>}
        </div>
        <fieldset onPointerUp={history.commit}>
          <legend>Resize</legend>
          <label>
            width
            <input
              type="number"
              min={1}
              value={live.width}
              onChange={(event) => history.setPresent({ ...live, width: Number(event.target.value) })}
              onBlur={history.commit}
            />
          </label>
          <label>
            height
            <input
              type="number"
              min={1}
              value={live.height}
              onChange={(event) => history.setPresent({ ...live, height: Number(event.target.value) })}
              onBlur={history.commit}
            />
          </label>
          <label>
            fit
            <select
              value={live.fit}
              onChange={(event) => {
                history.setPresent({ ...live, fit: event.target.value as 'inside' | 'cover' })
                history.commit()
              }}
            >
              <option value="inside">inside</option>
              <option value="cover">cover</option>
            </select>
          </label>
        </fieldset>
        <CropControl
          image={image}
          value={live.crop}
          enabled={live.cropEnabled}
          onEnabledChange={(cropEnabled) => {
            history.setPresent({ ...live, cropEnabled })
            history.commit()
          }}
          onChange={(crop) => history.setPresent({ ...live, crop })}
          onCommit={history.commit}
        />
        <LightControl
          value={live.light}
          onChange={(light) => history.setPresent({ ...live, light })}
          onCommit={history.commit}
        />
        <ColorControl
          value={live.color}
          onChange={(color) => history.setPresent({ ...live, color })}
          onCommit={history.commit}
        />
        <BlackAndWhiteControl
          enabled={live.bwEnabled}
          value={live.bw}
          onEnabledChange={(bwEnabled) => {
            history.setPresent({ ...live, bwEnabled })
            history.commit()
          }}
          onChange={(bw) => history.setPresent({ ...live, bw })}
          onCommit={history.commit}
        />
        <SharpenControl
          intensity={live.sharpenIntensity}
          onChange={(sharpenIntensity) => history.setPresent({ ...live, sharpenIntensity })}
          onCommit={history.commit}
        />
      </aside>
    </main>
  )
}
