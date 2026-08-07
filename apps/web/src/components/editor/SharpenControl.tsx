'use client'

interface SharpenControlProps {
  intensity: number
  onChange: (intensity: number) => void
  onCommit: () => void
}

export function SharpenControl({ intensity, onChange, onCommit }: SharpenControlProps) {
  return (
    <fieldset onPointerUp={onCommit}>
      <legend>Sharpen</legend>
      <label>
        Intensity ({intensity.toFixed(2)})
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={intensity}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    </fieldset>
  )
}
