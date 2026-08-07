'use client'

import type { AdjustColorParams } from '@/lib/recipe/schema'

interface ColorControlProps {
  value: AdjustColorParams
  onChange: (next: AdjustColorParams) => void
  onCommit: () => void
}

// Color's two P0 raw params (saturation, castStrength -- Vibrance/Grain
// schema+Go work still not done, see D-29/D-28 in
// docs/90-deferred-register.md) get direct sliders, no fan-out master
// blend and no "Adjust manually" toggle -- same precedent
// BlackAndWhiteControl.tsx already sets for a curated set of raw params
// with no fan-out blend, per docs/tasks/TASK-editor-composite-ui.md and
// docs/tasks/TASK-color-cast-preview-parity.md (resolved D-30).
export function ColorControl({ value, onChange, onCommit }: ColorControlProps) {
  return (
    <fieldset onPointerUp={onCommit}>
      <legend>Color</legend>
      <label>
        Saturation ({value.saturation.toFixed(2)})
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={value.saturation}
          onChange={(event) => onChange({ ...value, saturation: Number(event.target.value) })}
        />
      </label>
      <label>
        Cast ({value.castStrength.toFixed(2)})
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value.castStrength}
          onChange={(event) => onChange({ ...value, castStrength: Number(event.target.value) })}
        />
      </label>
    </fieldset>
  )
}
