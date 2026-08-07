import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jobOutputRef, type JobSummary } from '../editor/batch-progress'
import { applyJobProgressEvent, useJobProgress, type JobProgressEvent } from './useJobProgress'

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'job-1',
    pipelineId: 'pipeline-1',
    status: 'RUNNING',
    inputRef: 'uploads/a.jpg',
    steps: [
      { id: 's1', stepId: 'resize', processor: 'image.resize', order: 0, status: 'RUNNING', outputRef: null, error: null },
      { id: 's2', stepId: 'compress', processor: 'image.compress', order: 1, status: 'PENDING', outputRef: null, error: null },
    ],
    ...overrides,
  }
}

describe('applyJobProgressEvent', () => {
  it('a snapshot event replaces the held job wholesale', () => {
    const snapshot: JobProgressEvent = { scope: 'snapshot', job: job({ status: 'COMPLETE' }) }
    expect(applyJobProgressEvent(undefined, snapshot)).toEqual(job({ status: 'COMPLETE' }))
  })

  it('a job event updates only the top-level status', () => {
    const current = job()
    const result = applyJobProgressEvent(current, { scope: 'job', jobId: 'job-1', status: 'COMPLETE' })
    expect(result?.status).toBe('COMPLETE')
    expect(result?.steps).toEqual(current.steps)
  })

  it('a step event updates the matching step only', () => {
    const current = job()
    const result = applyJobProgressEvent(current, {
      scope: 'step',
      jobId: 'job-1',
      jobStepId: 's1',
      stepId: 'resize',
      order: 0,
      status: 'COMPLETE',
    })
    expect(result?.steps[0]).toMatchObject({ id: 's1', status: 'COMPLETE' })
    expect(result?.steps[1]).toEqual(current.steps[1])
  })

  it('carries over a step error', () => {
    const current = job()
    const result = applyJobProgressEvent(current, {
      scope: 'step',
      jobId: 'job-1',
      jobStepId: 's1',
      stepId: 'resize',
      order: 0,
      status: 'FAILED',
      error: 'boom',
    })
    expect(result?.steps[0]).toMatchObject({ status: 'FAILED', error: 'boom' })
  })

  it('a step-complete event carrying outputRef makes jobOutputRef resolve without a snapshot refetch', () => {
    const current = job()
    const result = applyJobProgressEvent(current, {
      scope: 'step',
      jobId: 'job-1',
      jobStepId: 's2',
      stepId: 'compress',
      order: 1,
      status: 'COMPLETE',
      outputRef: 'steps/s2.jpg',
    })
    expect(result?.steps[1]).toMatchObject({ status: 'COMPLETE', outputRef: 'steps/s2.jpg' })
    expect(result && jobOutputRef(result)).toBe('steps/s2.jpg')
  })

  it('ignores job/step events for a different job id than the one currently held', () => {
    const current = job()
    const result = applyJobProgressEvent(current, { scope: 'job', jobId: 'other-job', status: 'FAILED' })
    expect(result).toBe(current)
  })

  it('ignores job/step events when no snapshot has arrived yet', () => {
    const result = applyJobProgressEvent(undefined, { scope: 'job', jobId: 'job-1', status: 'RUNNING' })
    expect(result).toBeUndefined()
  })
})

// Minimal stand-in for the browser's EventSource -- jsdom doesn't implement
// it, and the real thing needs a live HTTP/SSE server. Exercises exactly
// the surface useJobProgress uses: construction with a URL, onmessage/
// onerror callbacks, and close().
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  emit(event: JobProgressEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  close(): void {
    this.closed = true
  }
}

describe('useJobProgress', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens an EventSource against GET /jobs/:id/events and applies incoming events', () => {
    const { result } = renderHook(() => useJobProgress('job-1'))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('http://localhost:3000/jobs/job-1/events')

    act(() => {
      FakeEventSource.instances[0].emit({ scope: 'snapshot', job: job() })
    })
    expect(result.current.job?.id).toBe('job-1')
    expect(result.current.job?.status).toBe('RUNNING')
  })

  it('closes the EventSource once a terminal status event arrives, instead of leaving it to auto-reconnect', () => {
    const { result } = renderHook(() => useJobProgress('job-1'))
    const source = FakeEventSource.instances[0]

    act(() => {
      source.emit({ scope: 'snapshot', job: job() })
    })
    expect(source.closed).toBe(false)

    act(() => {
      source.emit({ scope: 'job', jobId: 'job-1', status: 'COMPLETE' })
    })
    expect(source.closed).toBe(true)
    expect(result.current.job?.status).toBe('COMPLETE')
  })

  it('sets an error when the connection reports onerror', () => {
    const { result } = renderHook(() => useJobProgress('job-1'))
    const source = FakeEventSource.instances[0]

    act(() => {
      source.onerror?.()
    })
    expect(result.current.error).toBeInstanceOf(Error)
  })

  it('closes the previous EventSource and resets state when jobId changes', () => {
    const { result, rerender } = renderHook(
      ({ jobId }: { jobId: string | undefined }) => useJobProgress(jobId),
      { initialProps: { jobId: 'job-1' as string | undefined } },
    )
    const first = FakeEventSource.instances[0]
    act(() => {
      first.emit({ scope: 'snapshot', job: job() })
    })
    expect(result.current.job?.id).toBe('job-1')

    rerender({ jobId: 'job-2' })

    expect(first.closed).toBe(true)
    expect(result.current.job).toBeUndefined()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].url).toBe('http://localhost:3000/jobs/job-2/events')
  })

  it('does not open a connection when jobId is undefined', () => {
    renderHook(() => useJobProgress(undefined))
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})
