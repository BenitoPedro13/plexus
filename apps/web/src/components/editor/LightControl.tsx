'use client'

import { useState } from 'react'
import { applyLightBlend } from '@/lib/editor/light-blend'
import type { AdjustLightParams } from '@/lib/recipe/schema'

interface LightControlProps {
  value: AdjustLightParams
  onChange: (next: AdjustLightParams) => void
  onCommit: () => void
}

// The master "Light" slider fans a single value into four raw params via
// applyLightBlend -- see docs/tasks/TASK-editor-composite-ui.md for why
// that blend is one-directional (masterT is local UI state, never derived
// back from `value`). "Adjust manually" exposes the same four raw params
// individually, per the spec's "curated controls... with raw parameters
// tucked behind 'Adjust manually.'"
export function LightControl({ value, onChange, onCommit }: LightControlProps) {
  const [masterT, setMasterT] = useState(0)

  return (
    <fieldset onPointerUp={onCommit}>
      <legend>Light</legend>
      <label>
        Light ({masterT.toFixed(2)})
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={masterT}
          onChange={(event) => {
            const t = Number(event.target.value)
            setMasterT(t)
            onChange(applyLightBlend(t))
          }}
        />
      </label>
      <details>
        <summary>Adjust manually</summary>
        <label>
          Exposure ({value.exposure.toFixed(2)})
          <input
            type="range"
            min={-3}
            max={3}
            step={0.05}
            value={value.exposure}
            onChange={(event) => onChange({ ...value, exposure: Number(event.target.value) })}
          />
        </label>
        <label>
          Brightness ({value.brightness.toFixed(2)})
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={value.brightness}
            onChange={(event) => onChange({ ...value, brightness: Number(event.target.value) })}
          />
        </label>
        <label>
          Contrast ({value.contrast.toFixed(2)})
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={value.contrast}
            onChange={(event) => onChange({ ...value, contrast: Number(event.target.value) })}
          />
        </label>
        <label>
          Black Point ({value.blackPoint.toFixed(2)})
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={value.blackPoint}
            onChange={(event) => onChange({ ...value, blackPoint: Number(event.target.value) })}
          />
        </label>
      </details>
    </fieldset>
  )
}
