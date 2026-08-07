'use client'

import type { AdjustColorParams } from '@/lib/recipe/schema'
import { InstrumentSlider } from '@/components/editor/ui/Slider'
import { Section } from '@/components/editor/ui/Section'

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
    <Section title="Color">
      <InstrumentSlider
        label="Saturation"
        value={value.saturation}
        min={-1}
        max={1}
        step={0.05}
        bipolar
        onChange={(saturation) => onChange({ ...value, saturation })}
        onCommit={onCommit}
      />
      <InstrumentSlider
        label="Cast"
        value={value.castStrength}
        min={0}
        max={1}
        step={0.05}
        onChange={(castStrength) => onChange({ ...value, castStrength })}
        onCommit={onCommit}
      />
    </Section>
  )
}
