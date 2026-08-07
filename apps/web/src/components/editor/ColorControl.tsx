'use client'

interface ColorControlProps {
  saturation: number
  onChange: (saturation: number) => void
  onCommit: () => void
}

// Color has exactly one P0 param (saturation -- Vibrance/Cast are
// V-8-blocked), so it's already the raw param: no fan-out blend and no
// "Adjust manually" toggle needed, per docs/tasks/TASK-editor-composite-ui.md.
export function ColorControl({ saturation, onChange, onCommit }: ColorControlProps) {
  return (
    <fieldset onPointerUp={onCommit}>
      <legend>Color</legend>
      <label>
        Saturation ({saturation.toFixed(2)})
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={saturation}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    </fieldset>
  )
}
