import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export interface Crumb {
  label: string
  href?: string
}

interface AppHeaderProps {
  crumbs: Crumb[]
  right?: ReactNode
}

const linkClass =
  'flex items-center gap-1 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground'
const currentClass = 'font-mono text-[11px] tracking-[0.08em] text-foreground uppercase'

// Shared page header: a breadcrumb trail (all but the last crumb are links;
// a single-crumb list -- home's case -- renders as a plain non-link label,
// same as the old hand-written "Plexus" wordmark) plus an optional trailing
// slot for page-specific actions. Extracted from six near-identical,
// slowly-drifting copies (docs/tasks/TASK-action-first-navigation.md item 1)
// -- two of those copies had no way back to /jobs at all.
export function AppHeader({ crumbs, right }: AppHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        return (
          <span key={crumb.label} className="flex items-center gap-3">
            {index > 0 && <span className="text-muted-foreground">·</span>}
            {crumb.href && !isLast ? (
              <Link href={crumb.href} className={linkClass}>
                {index === 0 && <ArrowLeft className="size-3.5" />}
                {crumb.label}
              </Link>
            ) : (
              <span className={currentClass}>{crumb.label}</span>
            )}
          </span>
        )
      })}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </header>
  )
}

export function JobsLink() {
  return (
    <Link href="/jobs" className={linkClass}>
      Jobs
    </Link>
  )
}
