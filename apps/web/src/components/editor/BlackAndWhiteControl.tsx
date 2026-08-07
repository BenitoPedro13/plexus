'use client'

import type { BlackAndWhiteParams } from '@/lib/recipe/schema'
import { InstrumentSlider } from '@/components/editor/ui/Slider'
import { Section } from '@/components/editor/ui/Section'
import { Switch } from '@/components/ui/switch'

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
    <Section
      title="Black & White"
      headerExtra={
        <Switch
          size="sm"
          checked={enabled}
          onCheckedChange={(checked) => {
            onEnabledChange(checked)
            onCommit()
          }}
          aria-label="Enable black & white"
        />
      }
    >
      <InstrumentSlider
        label="Intensity"
        value={value.intensity}
        min={0}
        max={1}
        step={0.05}
        disabled={!enabled}
        onChange={(intensity) => onChange({ ...value, intensity })}
        onCommit={onCommit}
      />
      <InstrumentSlider
        label="Neutrals"
        value={value.neutrals}
        min={-1}
        max={1}
        step={0.05}
        bipolar
        disabled={!enabled}
        onChange={(neutrals) => onChange({ ...value, neutrals })}
        onCommit={onCommit}
      />
      <InstrumentSlider
        label="Tone"
        value={value.tone}
        min={-1}
        max={1}
        step={0.05}
        bipolar
        disabled={!enabled}
        onChange={(tone) => onChange({ ...value, tone })}
        onCommit={onCommit}
      />
      <InstrumentSlider
        label="Grain"
        value={value.grain}
        min={0}
        max={1}
        step={0.05}
        disabled={!enabled}
        onChange={(grain) => onChange({ ...value, grain })}
        onCommit={onCommit}
      />
    </Section>
  )
}
