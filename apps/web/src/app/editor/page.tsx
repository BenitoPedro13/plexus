'use client'

import { useEffect, useState } from 'react'
import { BlackAndWhiteControl } from '@/components/editor/BlackAndWhiteControl'
import { ColorControl } from '@/components/editor/ColorControl'
import { LightControl } from '@/components/editor/LightControl'
import { SharpenControl } from '@/components/editor/SharpenControl'
import { PreviewCanvas } from '@/components/PreviewCanvas'
import { useRecipeHistory } from '@/lib/editor/history'
import { identityLightParams } from '@/lib/editor/light-blend'
import type { AdjustLightParams, BlackAndWhiteParams, Recipe } from '@/lib/recipe/schema'

interface EditState {
  width: number
  height: number
  fit: 'inside' | 'cover'
  light: AdjustLightParams
  saturation: number
  bwEnabled: boolean
  bw: BlackAndWhiteParams
  sharpenIntensity: number
}

const identityBwParams: BlackAndWhiteParams = { intensity: 0, neutrals: 0, tone: 0 }

const initialEditState: EditState = {
  width: 400,
  height: 400,
  fit: 'inside',
  light: identityLightParams,
  saturation: 0,
  bwEnabled: false,
  bw: identityBwParams,
  sharpenIntensity: 0,
}

// Only emits a composite step when it differs from identity (B&W: when
// enabled at all) -- keeps hand-edited recipes minimal instead of a fixed
// five-step stack of mostly no-ops, per docs/tasks/TASK-editor-composite-ui.md.
function deriveRecipe(state: EditState): Recipe {
  const steps: Recipe['steps'] = [
    {
      id: 'resize',
      processor: 'image.resize',
      params: { width: state.width, height: state.height, fit: state.fit },
    },
  ]

  const { light } = state
  if (light.exposure !== 0 || light.brightness !== 0 || light.contrast !== 0 || light.blackPoint !== 0) {
    steps.push({ id: 'light', processor: 'image.adjustLight', params: light })
  }

  if (state.saturation !== 0) {
    steps.push({
      id: 'color',
      processor: 'image.adjustColor',
      params: { saturation: state.saturation },
    })
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
  }

  const recipe = deriveRecipe(live)

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
          </button>
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
        <LightControl
          value={live.light}
          onChange={(light) => history.setPresent({ ...live, light })}
          onCommit={history.commit}
        />
        <ColorControl
          saturation={live.saturation}
          onChange={(saturation) => history.setPresent({ ...live, saturation })}
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
