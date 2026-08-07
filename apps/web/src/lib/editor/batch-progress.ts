import { orchestratorUrl } from './batch'

export type JobStatus = 'QUEUED' | 'RUNNING' | 'PARTIAL' | 'COMPLETE' | 'FAILED'
export type JobStepStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'SKIPPED'

export interface JobStepSummary {
  id: string
  stepId: string
  processor: string
  order: number
  status: JobStepStatus
  outputRef: string | null
  error: string | null
}

// Mirrors apps/orchestrator/src/jobs/jobs.service.ts's JobWithSteps as
// GET /jobs/:id serializes it -- this is the polling fallback
// TASK-realtime-progress-sse.md's SSE stream would eventually replace, per
// docs/tasks/TASK-apply-to-batch.md.
export interface JobSummary {
  id: string
  pipelineId: string
  status: JobStatus
  inputRef: string
  steps: JobStepSummary[]
}

export async function fetchJob(jobId: string, fetchImpl: typeof fetch = fetch): Promise<JobSummary> {
  const res = await fetchImpl(orchestratorUrl(`/jobs/${jobId}`))
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`fetch job "${jobId}" failed (${res.status}): ${text || res.statusText}`)
  }
  return res.json()
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === 'COMPLETE' || status === 'FAILED'
}

// Steps run in `order` -- count how many have reached a settled state
// (COMPLETE or SKIPPED) out of the total, for a simple N-of-M progress bar.
// A FAILED step also counts as "settled" so a failed job's bar still reads
// as done rather than stuck.
export function jobStepProgress(job: JobSummary): { completed: number; total: number } {
  const settled = job.steps.filter(
    (step) => step.status === 'COMPLETE' || step.status === 'SKIPPED' || step.status === 'FAILED',
  ).length
  return { completed: settled, total: job.steps.length }
}

// The final step's outputRef (steps are already order-sorted by
// JobsService.findOne) -- undefined until the job is COMPLETE.
export function jobOutputRef(job: JobSummary): string | undefined {
  const last = job.steps.at(-1)
  return last?.status === 'COMPLETE' ? (last.outputRef ?? undefined) : undefined
}

export async function fetchDownloadUrl(objectKey: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(orchestratorUrl(`/uploads/presign-download?key=${encodeURIComponent(objectKey)}`))
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`presign download failed (${res.status}): ${text || res.statusText}`)
  }
  const { downloadUrl } = await res.json()
  return downloadUrl
}
