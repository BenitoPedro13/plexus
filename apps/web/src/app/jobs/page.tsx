'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CircleCheck, CircleX, Loader2, Trash2 } from 'lucide-react'
import { AppHeader } from '@/components/AppHeader'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  fetchDownloadUrl,
  jobOutputRef,
  jobStepProgress,
  JOB_STATUS_BADGE_VARIANT,
  JOB_STATUS_LABEL,
} from '@/lib/editor/batch-progress'
import { useJobProgress } from '@/lib/jobs/useJobProgress'
import { clearRecentJobs, listRecentJobs, type RecentJob } from '@/lib/jobs/recentJobs'
import { cn } from '@/lib/utils'

function relativeTime(iso: string): string {
  const diffMs = Date.parse(iso) - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour')
  return formatter.format(Math.round(diffHours / 24), 'day')
}

// One row per browser-tracked job -- live status via the same SSE hook the
// single-job page uses (apps/web/src/lib/jobs/useJobProgress.ts), not
// polling, since this page can show many rows at once.
function JobRow({ entry }: { entry: RecentJob }) {
  const { job, error } = useJobProgress(entry.jobId)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    if (!job) return
    const outputRef = jobOutputRef(job)
    if (!outputRef) return
    let cancelled = false
    fetchDownloadUrl(outputRef)
      .then((url) => {
        if (!cancelled) setDownloadUrl(url)
      })
      .catch((err) => {
        if (!cancelled) setDownloadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [job])

  const { completed, total } = job ? jobStepProgress(job) : { completed: 0, total: 0 }
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className="flex flex-col gap-2 border-b border-border py-4 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/quick-actions/${entry.jobId}`}
          className="min-w-0 truncate text-sm text-foreground hover:text-primary"
        >
          {entry.label}
        </Link>
        {job && (
          <Badge
            variant={JOB_STATUS_BADGE_VARIANT[job.status]}
            className="shrink-0 font-mono text-[10px] uppercase"
          >
            {job.status === 'RUNNING' && <Loader2 className="animate-spin" />}
            {job.status === 'COMPLETE' && <CircleCheck />}
            {job.status === 'FAILED' && <CircleX />}
            {JOB_STATUS_LABEL[job.status]}
          </Badge>
        )}
      </div>

      <Progress value={percent} />

      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {job ? `${completed}/${total} steps` : 'Loading…'} · {relativeTime(entry.createdAt)}
        </span>
        {downloadUrl && (
          <a
            href={downloadUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'font-mono text-[10px] uppercase')}
          >
            Download
          </a>
        )}
      </div>

      {(error || downloadError || job?.steps.some((step) => step.error)) && (
        <p className="font-mono text-[11px] text-destructive">
          {error?.message ?? downloadError ?? job?.steps.find((step) => step.error)?.error}
        </p>
      )}
    </div>
  )
}

// Per-browser history of quick-actions jobs (TASK-jobs-list-page.md) -- the
// gap this closes: quick-actions creates one job at a time and immediately
// navigates to it, so starting a second job before the first finishes had no
// way back to the first. Jobs are tracked client-side via
// apps/web/src/lib/jobs/recentJobs.ts (localStorage), not a server-side
// list -- there's no auth/user concept yet, so a global list would show
// every browser's jobs to every other browser.
export default function JobsPage() {
  const [jobs, setJobs] = useState<RecentJob[]>([])

  useEffect(() => {
    // localStorage isn't available during SSR; reading it in an effect
    // (rather than a lazy useState initializer) avoids a hydration mismatch
    // between the server's empty render and the client's real data --
    // same precedent as quick-actions/page.tsx's takePendingFile() read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJobs(listRecentJobs())
  }, [])

  function handleClear() {
    clearRecentJobs()
    setJobs([])
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader
        crumbs={[{ label: 'Home', href: '/' }, { label: 'Jobs' }]}
        right={
          jobs.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleClear} className="font-mono text-[10px] uppercase">
              <Trash2 />
              Clear
            </Button>
          )
        }
      />

      <div className="mx-auto w-full max-w-xl flex-1 px-4 py-6">
        {jobs.length === 0 ? (
          <p className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
            No jobs yet -- start one from{' '}
            <Link href="/quick-actions" className="text-foreground hover:text-primary">
              Quick Actions
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-col">
            {jobs.map((entry) => (
              <JobRow key={entry.jobId} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
