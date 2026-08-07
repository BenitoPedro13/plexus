interface SectionProps {
  title: string
  headerExtra?: React.ReactNode
  children: React.ReactNode
}

// The recurring section chrome for the right-hand control rail -- a mono
// tracked-out label and a hairline divider, not a boxed <fieldset>, so the
// rail reads like a settings/spec list rather than a stack of form boxes.
// See docs/tasks/TASK-editor-visual-design.md.
export function Section({ title, headerExtra, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-3 border-b border-border py-4 first:pt-0 last:border-b-0">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase">
          {title}
        </h2>
        {headerExtra}
      </div>
      {children}
    </section>
  )
}
