import { useEffect, useState } from 'react'
import { orchestratorUrl } from '../editor/batch'
import {
  isTerminalJobStatus,
  type JobStatus,
  type JobStepStatus,
  type JobSummary,
} from '../editor/batch-progress'

// Mirrors apps/orchestrator/src/jobs/job-progress-event.ts's JobProgressEvent
// union as GET /jobs/:id/events (TASK-realtime-progress-sse.md) serializes
// it over SSE. `snapshot.job` has the same shape batch-progress.ts's
// JobSummary already mirrors from GET /jobs/:id.
export type JobProgressEvent =
  | { scope: 'snapshot'; job: JobSummary }
  | { scope: 'job'; jobId: string; status: JobStatus }
  | {
      scope: 'step'
      jobId: string
      jobStepId: string
      stepId: string
      order: number
      status: JobStepStatus
      error?: string
      outputRef?: string
    }

// Pure reducer, unit-tested on its own (same extraction precedent as
// light-blend.ts/crop-drag.ts) -- folds one incoming event into the
// locally-held job snapshot. `snapshot` always replaces wholesale; `job`/
// `step` events are ignored if they arrive for a different job id than the
// one currently held (stale event from a just-superseded EventSource) or
// before any snapshot has arrived yet.
export function applyJobProgressEvent(
  current: JobSummary | undefined,
  event: JobProgressEvent,
): JobSummary | undefined {
  if (event.scope === 'snapshot') {
    return event.job
  }
  if (!current || current.id !== event.jobId) {
    return current
  }
  if (event.scope === 'job') {
    return { ...current, status: event.status }
  }
  return {
    ...current,
    steps: current.steps.map((step) =>
      step.id === event.jobStepId
        ? {
            ...step,
            status: event.status,
            error: event.error ?? step.error,
            outputRef: event.outputRef ?? step.outputRef,
          }
        : step,
    ),
  }
}

export interface UseJobProgressResult {
  job: JobSummary | undefined
  error: Error | undefined
}

interface JobProgressState {
  jobId: string | undefined
  job: JobSummary | undefined
  error: Error | undefined
}

// Live job progress via GET /jobs/:id/events. The native EventSource
// reconnects itself on a dropped connection; every fresh connection's first
// event is always a DB snapshot (see JobsService.streamEvents), so a
// reconnect self-heals without this hook tracking sequence numbers. Once a
// terminal status is observed the source is closed explicitly -- otherwise
// EventSource's default auto-reconnect would keep reopening a stream that
// immediately re-completes (the job stays terminal), a needless loop.
export function useJobProgress(jobId: string | undefined): UseJobProgressResult {
  const [state, setState] = useState<JobProgressState>({
    jobId,
    job: undefined,
    error: undefined,
  })

  // Resets held state synchronously during render when jobId changes --
  // the React-endorsed way to "adjust state when a prop changes" without
  // routing it through an Effect (react.dev, "You Might Not Need an
  // Effect"). The Effect below only owns the EventSource subscription;
  // setState inside *its* callbacks is the other endorsed case ("subscribe
  // for updates from an external system").
  if (state.jobId !== jobId) {
    setState({ jobId, job: undefined, error: undefined })
  }

  useEffect(() => {
    if (!jobId) {
      return
    }

    const source = new EventSource(orchestratorUrl(`/jobs/${jobId}/events`))

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as JobProgressEvent
      setState((current) =>
        current.jobId === jobId
          ? { ...current, job: applyJobProgressEvent(current.job, event) }
          : current,
      )

      const status =
        event.scope === 'snapshot'
          ? event.job.status
          : event.scope === 'job'
            ? event.status
            : undefined
      if (status && isTerminalJobStatus(status)) {
        source.close()
      }
    }
    source.onerror = () => {
      setState((current) =>
        current.jobId === jobId
          ? { ...current, error: new Error(`SSE connection to job "${jobId}" events failed`) }
          : current,
      )
    }

    return () => source.close()
  }, [jobId])

  return { job: state.job, error: state.error }
}
