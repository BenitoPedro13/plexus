'use client'

import { Slider as ShadcnSlider } from '@/components/ui/slider'

interface InstrumentSliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** Center-zero fill for -N..N params (exposure-compensation style). */
  bipolar?: boolean
  /** Value the readout treats as "untouched" -- defaults to 0. */
  identity?: number
  disabled?: boolean
  onChange: (value: number) => void
  onCommit: () => void
}

function formatReadout(value: number, bipolar: boolean): string {
  const fixed = value.toFixed(2)
  return bipolar && value > 0 ? `+${fixed}` : fixed
}

// One row: mono tracked-out label, the readout window (lights up in the
// safelight accent once the value leaves identity), and the instrument
// slider itself -- the recurring unit every composite control in
// apps/web/src/components/editor is built from. See
// docs/tasks/TASK-editor-visual-design.md.
export function InstrumentSlider({
  label,
  value,
  min,
  max,
  step,
  bipolar = false,
  identity = 0,
  disabled = false,
  onChange,
  onCommit,
}: InstrumentSliderProps) {
  const touched = value !== identity

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </span>
        <span
          className={`rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[11px] tabular-nums ${
            touched ? 'text-primary' : 'text-muted-foreground'
          }`}
        >
          {formatReadout(value, bipolar)}
        </span>
      </div>
      <ShadcnSlider
        value={value}
        min={min}
        max={max}
        step={step}
        bipolar={bipolar}
        disabled={disabled}
        onValueChange={([next]) => onChange(next)}
        onValueCommit={onCommit}
      />
    </div>
  )
}
