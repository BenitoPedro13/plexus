"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Single-thumb only (no range-select mode) -- every editor param is one
// number, never a [lo, hi] pair, so the multi-thumb .map() the generator
// ships is dead weight here. `bipolar` swaps the fill for a center-zero
// origin instead of Radix's default "fill from min" -- see
// docs/tasks/TASK-editor-visual-design.md: an exposure-compensation-style
// dial, matching these params' actual -N..N domain, where a generic
// left-to-right fill would misrepresent "0" as "empty."
function Slider({
  className,
  value,
  min = 0,
  max = 100,
  bipolar = false,
  ...props
}: Omit<React.ComponentProps<typeof SliderPrimitive.Root>, "value" | "defaultValue"> & {
  value: number
  bipolar?: boolean
}) {
  const centerPercent = bipolar ? ((0 - min) / (max - min)) * 100 : 0
  const valuePercent = ((value - min) / (max - min)) * 100

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={[value]}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1 w-full grow overflow-hidden rounded-full bg-secondary"
      >
        {bipolar ? (
          <>
            <div
              aria-hidden
              className="absolute inset-y-0 w-px bg-border"
              style={{ left: `${centerPercent}%` }}
            />
            <div
              data-slot="slider-range"
              className="absolute h-full select-none bg-primary"
              style={{
                left: `${Math.min(centerPercent, valuePercent)}%`,
                width: `${Math.abs(valuePercent - centerPercent)}%`,
              }}
            />
          </>
        ) : (
          <SliderPrimitive.Range
            data-slot="slider-range"
            className="absolute h-full select-none bg-primary"
          />
        )}
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        className="block size-3.5 shrink-0 rounded-full border-2 border-primary bg-background ring-ring/50 transition-[box-shadow] select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden active:ring-4 disabled:pointer-events-none disabled:opacity-50"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
