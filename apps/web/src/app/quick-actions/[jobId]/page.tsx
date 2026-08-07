'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  fetchDownloadUrl,
  jobOutputRef,
  jobStepProgress,
  JOB_STATUS_BADGE_VARIANT,
  JOB_STATUS_LABEL,
} from '@/lib/editor/batch-progress'
import { useJobProgress } from '@/lib/jobs/useJobProgress'
import { cn } from '@/lib/utils'

// Single-job progress + download view for the quick-actions flow -- the
// SSE-driven sibling of /batch/[pipelineId] (which still polls GET
// /jobs/:id; TASK-realtime-progress-sse.md's stream wasn't wired into the
// batch view yet, a noted follow-up in the spec). This new page uses the SSE
// hook (apps/web/src/lib/jobs/useJobProgress.ts) directly rather than
// inheriting the polling fallback. See docs/tasks/TASK-quick-actions-screen.md.
export default function QuickActionsJobPage() {
  const params = useParams<{ jobId: string }>()
  const { job, error } = useJobProgress(params.jobId)
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
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Link
          href="/quick-actions"
          className="flex items-center gap-1 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Quick Actions
        </Link>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase">Job</span>
      </header>

      <div className="mx-auto w-full max-w-xl flex-1 px-4 py-10">
        {!job && !error && (
          <p className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
            Loading…
          </p>
        )}

        {job && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
                {job.steps.length} step{job.steps.length === 1 ? '' : 's'}
              </span>
              <Badge
                variant={JOB_STATUS_BADGE_VARIANT[job.status]}
                className="font-mono text-[10px] uppercase"
              >
                {job.status === 'RUNNING' && <Loader2 className="animate-spin" />}
                {job.status === 'COMPLETE' && <CircleCheck />}
                {job.status === 'FAILED' && <CircleX />}
                {JOB_STATUS_LABEL[job.status]}
              </Badge>
            </div>

            <Progress value={percent} />

            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {completed}/{total} steps
            </span>

            {downloadUrl && (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  buttonVariants({ variant: 'default', size: 'sm' }),
                  'w-fit font-mono text-[10px] uppercase',
                )}
              >
                Download
              </a>
            )}

            {(error || downloadError || job.steps.some((step) => step.error)) && (
              <p className="font-mono text-[11px] text-destructive">
                {error?.message ?? downloadError ?? job.steps.find((step) => step.error)?.error}
              </p>
            )}
          </div>
        )}

        {!job && error && <p className="font-mono text-[11px] text-destructive">{error.message}</p>}
      </div>
    </div>
  )
}
