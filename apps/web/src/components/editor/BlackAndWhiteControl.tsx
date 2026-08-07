'use client'

import type { BlackAndWhiteParams } from '@/lib/recipe/schema'

interface BlackAndWhiteControlProps {
  enabled: boolean
  value: BlackAndWhiteParams
  onEnabledChange: (enabled: boolean) => void
  onChange: (next: BlackAndWhiteParams) => void
  onCommit: () => void
}

// Apple's own B&W pane shows Intensity/Neutrals/Tone directly (per
// docs/tasks/TASK-composite-slider-mapping.md's research) -- no invented
// single master slider fanning into three params here. Disabled state omits
// the image.blackAndWhite step from the recipe entirely (a distinct look
// being toggled, not a slider parked at intensity=0).
export function BlackAndWhiteControl({
  enabled,
  value,
  onEnabledChange,
  onChange,
  onCommit,
}: BlackAndWhiteControlProps) {
  return (
    <fieldset onPointerUp={onCommit}>
      <legend>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          Black &amp; White
        </label>
      </legend>
      <label>
        Intensity ({value.intensity.toFixed(2)})
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value.intensity}
          disabled={!enabled}
          onChange={(event) => onChange({ ...value, intensity: Number(event.target.value) })}
        />
      </label>
      <label>
        Neutrals ({value.neutrals.toFixed(2)})
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={value.neutrals}
          disabled={!enabled}
          onChange={(event) => onChange({ ...value, neutrals: Number(event.target.value) })}
        />
      </label>
      <label>
        Tone ({value.tone.toFixed(2)})
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={value.tone}
          disabled={!enabled}
          onChange={(event) => onChange({ ...value, tone: Number(event.target.value) })}
        />
      </label>
    </fieldset>
  )
}
