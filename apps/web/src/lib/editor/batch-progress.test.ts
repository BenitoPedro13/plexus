import { describe, expect, it, vi } from 'vitest'
import {
  fetchDownloadUrl,
  fetchJob,
  isTerminalJobStatus,
  jobOutputRef,
  jobStepProgress,
  type JobSummary,
} from './batch-progress'

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'job-1',
    pipelineId: 'pipeline-1',
    status: 'RUNNING',
    inputRef: 'uploads/a.jpg',
    steps: [
      { id: 's1', stepId: 'resize', processor: 'image.resize', order: 0, status: 'COMPLETE', outputRef: 'steps/s1.png', error: null },
      { id: 's2', stepId: 'compress', processor: 'image.compress', order: 1, status: 'RUNNING', outputRef: null, error: null },
    ],
    ...overrides,
  }
}

describe('fetchJob', () => {
  it('GETs /jobs/:id and returns the parsed job', async () => {
    const summary = job()
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(summary) })

    const result = await fetchJob('job-1', fetchImpl as unknown as typeof fetch)

    expect(result).toEqual(summary)
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3000/jobs/job-1')
  })

  it('throws with the server error text on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('Job "job-1" not found'),
    })

    await expect(fetchJob('job-1', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/404.*not found/)
  })
})

describe('isTerminalJobStatus', () => {
  it('treats COMPLETE, FAILED, and PARTIAL as terminal, QUEUED/RUNNING as not', () => {
    expect(isTerminalJobStatus('COMPLETE')).toBe(true)
    expect(isTerminalJobStatus('FAILED')).toBe(true)
    expect(isTerminalJobStatus('PARTIAL')).toBe(true)
    expect(isTerminalJobStatus('QUEUED')).toBe(false)
    expect(isTerminalJobStatus('RUNNING')).toBe(false)
  })
})

describe('jobStepProgress', () => {
  it('counts COMPLETE/SKIPPED/FAILED steps as settled out of the total', () => {
    expect(jobStepProgress(job())).toEqual({ completed: 1, total: 2 })

    const allDone = job({
      steps: [
        { id: 's1', stepId: 'resize', processor: 'image.resize', order: 0, status: 'COMPLETE', outputRef: 'x', error: null },
        { id: 's2', stepId: 'compress', processor: 'image.compress', order: 1, status: 'FAILED', outputRef: null, error: 'boom' },
      ],
    })
    expect(jobStepProgress(allDone)).toEqual({ completed: 2, total: 2 })
  })
})

describe('jobOutputRef', () => {
  it('returns the last step outputRef only when that step is COMPLETE', () => {
    const complete = job({
      steps: [
        { id: 's1', stepId: 'resize', processor: 'image.resize', order: 0, status: 'COMPLETE', outputRef: 'steps/s1.png', error: null },
        { id: 's2', stepId: 'compress', processor: 'image.compress', order: 1, status: 'COMPLETE', outputRef: 'steps/s2.png', error: null },
      ],
    })
    expect(jobOutputRef(complete)).toBe('steps/s2.png')

    expect(jobOutputRef(job())).toBeUndefined()
  })
})

describe('fetchDownloadUrl', () => {
  it('GETs the presign-download endpoint with the key query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ downloadUrl: 'https://minio.local/get-me' }),
    })

    const url = await fetchDownloadUrl('steps/s2.png', fetchImpl as unknown as typeof fetch)

    expect(url).toBe('https://minio.local/get-me')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3000/uploads/presign-download?key=steps%2Fs2.png',
    )
  })
})
