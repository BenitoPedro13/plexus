'use client'

import { useState } from 'react'
import { applyLightBlend } from '@/lib/editor/light-blend'
import type { AdjustLightParams } from '@/lib/recipe/schema'
import { InstrumentSlider } from '@/components/editor/ui/Slider'
import { Section } from '@/components/editor/ui/Section'

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
    <Section title="Light">
      <InstrumentSlider
        label="Light"
        value={masterT}
        min={-1}
        max={1}
        step={0.01}
        bipolar
        onChange={(t) => {
          setMasterT(t)
          onChange(applyLightBlend(t))
        }}
        onCommit={onCommit}
      />
      <details className="group">
        <summary className="cursor-pointer font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase select-none [&::-webkit-details-marker]:hidden">
          <span className="mr-1 inline-block transition-transform group-open:rotate-90">
            &rsaquo;
          </span>
          Adjust manually
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <InstrumentSlider
            label="Exposure"
            value={value.exposure}
            min={-3}
            max={3}
            step={0.05}
            bipolar
            onChange={(exposure) => onChange({ ...value, exposure })}
            onCommit={onCommit}
          />
          <InstrumentSlider
            label="Brightness"
            value={value.brightness}
            min={-1}
            max={1}
            step={0.05}
            bipolar
            onChange={(brightness) => onChange({ ...value, brightness })}
            onCommit={onCommit}
          />
          <InstrumentSlider
            label="Contrast"
            value={value.contrast}
            min={-1}
            max={1}
            step={0.05}
            bipolar
            onChange={(contrast) => onChange({ ...value, contrast })}
            onCommit={onCommit}
          />
          <InstrumentSlider
            label="Black Point"
            value={value.blackPoint}
            min={0}
            max={1}
            step={0.05}
            onChange={(blackPoint) => onChange({ ...value, blackPoint })}
            onCommit={onCommit}
          />
          <InstrumentSlider
            label="Highlights"
            value={value.highlights}
            min={-1}
            max={1}
            step={0.05}
            bipolar
            onChange={(highlights) => onChange({ ...value, highlights })}
            onCommit={onCommit}
          />
          <InstrumentSlider
            label="Shadows"
            value={value.shadows}
            min={-1}
            max={1}
            step={0.05}
            bipolar
            onChange={(shadows) => onChange({ ...value, shadows })}
            onCommit={onCommit}
          />
        </div>
      </details>
    </Section>
  )
}
