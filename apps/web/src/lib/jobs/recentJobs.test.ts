import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecentJobs, listRecentJobs, recordRecentJob, type RecentJob } from './recentJobs'

// jsdom's own localStorage implementation is unreliable across environments
// (observed to be undefined under this project's vitest/jsdom versions on
// the default about:blank-ish origin) -- a minimal in-memory stand-in is
// simpler and more deterministic than chasing jsdom config, matching the
// FakeEventSource precedent already used for useJobProgress.test.ts.
class FakeStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

function entry(overrides: Partial<RecentJob> = {}): RecentJob {
  return {
    jobId: 'job-1',
    pipelineId: 'pipeline-1',
    label: 'Shrink for sharing -- clip.mp4',
    createdAt: '2026-08-07T22:10:00.000Z',
    ...overrides,
  }
}

describe('recentJobs', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists nothing before any job is recorded', () => {
    expect(listRecentJobs()).toEqual([])
  })

  it('records a job and lists it back', () => {
    recordRecentJob(entry())
    expect(listRecentJobs()).toEqual([entry()])
  })

  it('lists newest first', () => {
    recordRecentJob(entry({ jobId: 'job-1' }))
    recordRecentJob(entry({ jobId: 'job-2' }))
    expect(listRecentJobs().map((job) => job.jobId)).toEqual(['job-2', 'job-1'])
  })

  it('de-dupes by jobId, keeping the latest entry in its newest-first position', () => {
    recordRecentJob(entry({ jobId: 'job-1', label: 'First label' }))
    recordRecentJob(entry({ jobId: 'job-2' }))
    recordRecentJob(entry({ jobId: 'job-1', label: 'Updated label' }))

    const jobs = listRecentJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ jobId: 'job-1', label: 'Updated label' })
  })

  it('caps the stored list at 50 entries, dropping the oldest', () => {
    for (let i = 0; i < 55; i++) {
      recordRecentJob(entry({ jobId: `job-${i}` }))
    }
    const jobs = listRecentJobs()
    expect(jobs).toHaveLength(50)
    expect(jobs[0].jobId).toBe('job-54')
    expect(jobs.some((job) => job.jobId === 'job-0')).toBe(false)
  })

  it('returns an empty list rather than throwing on corrupt stored content', () => {
    window.localStorage.setItem('plexus.recentJobs', 'not json')
    expect(listRecentJobs()).toEqual([])
  })

  it('clears the stored list', () => {
    recordRecentJob(entry())
    clearRecentJobs()
    expect(listRecentJobs()).toEqual([])
  })
})
