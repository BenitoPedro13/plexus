'use client'

import { useParams, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { AppHeader, JobsLink } from '@/components/AppHeader'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  fetchDownloadUrl,
  fetchJob,
  isTerminalJobStatus,
  jobOutputRef,
  jobStepProgress,
  JOB_STATUS_BADGE_VARIANT,
  JOB_STATUS_LABEL,
  type JobSummary,
} from '@/lib/editor/batch-progress'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 2000

// One row per job -- polls GET /jobs/:id on its own cadence and stops once
// the job reaches a terminal status. Kept as its own component (rather than
// one shared interval in the parent) so a failed/slow job never blocks
// other rows from updating, and so the polling stops per-row exactly when
// that row no longer needs it.
function JobRow({ jobId, index }: { jobId: string; index: number }) {
  const [job, setJob] = useState<JobSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      try {
        const next = await fetchJob(jobId)
        if (cancelled) return
        setJob(next)
        if (!isTerminalJobStatus(next.status)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId])

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
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
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
        <span className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          File {index + 1}
        </span>
        {job && (
          <Badge variant={JOB_STATUS_BADGE_VARIANT[job.status]} className="font-mono text-[10px] uppercase">
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
          {job ? `${completed}/${total} steps` : 'Loading…'}
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

      {(error || job?.steps.some((step) => step.error)) && (
        <p className="font-mono text-[11px] text-destructive">
          {error ?? job?.steps.find((step) => step.error)?.error}
        </p>
      )}
    </div>
  )
}

// Batch progress view -- one row per job created by the editor's
// Apply-to-Batch flow (apps/web/src/lib/editor/batch.ts). Job ids travel in
// the URL's query string rather than a new "list jobs by pipeline"
// orchestrator endpoint, keeping the page a pure function of its URL
// (refresh-safe, shareable) without adding server surface area the task
// doc's audit found unnecessary. See docs/tasks/TASK-apply-to-batch.md.
export default function BatchProgressPage() {
  const params = useParams<{ pipelineId: string }>()
  const searchParams = useSearchParams()
  const jobIdsParam = searchParams.get('jobs') ?? ''
  const jobIds = useMemo(() => jobIdsParam.split(',').filter(Boolean), [jobIdsParam])

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader
        crumbs={[{ label: 'Editor', href: '/editor' }, { label: 'Batch' }]}
        right={
          <>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{params.pipelineId}</span>
            <JobsLink />
          </>
        }
      />

      <div className="mx-auto w-full max-w-xl flex-1 px-4 py-6">
        {jobIds.length === 0 ? (
          <p className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
            No jobs to show -- missing &quot;jobs&quot; query parameter.
          </p>
        ) : (
          <>
            <h1 className="mb-4 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
              {jobIds.length} file{jobIds.length === 1 ? '' : 's'}
            </h1>
            <div className="flex flex-col">
              {jobIds.map((jobId, index) => (
                <JobRow key={jobId} jobId={jobId} index={index} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
