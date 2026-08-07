'use client'

import { InstrumentSlider } from '@/components/editor/ui/Slider'
import { Section } from '@/components/editor/ui/Section'

interface SharpenControlProps {
  intensity: number
  onChange: (intensity: number) => void
  onCommit: () => void
}

export function SharpenControl({ intensity, onChange, onCommit }: SharpenControlProps) {
  return (
    <Section title="Sharpen">
      <InstrumentSlider
        label="Intensity"
        value={intensity}
        min={0}
        max={1}
        step={0.05}
        onChange={onChange}
        onCommit={onCommit}
      />
    </Section>
  )
}
