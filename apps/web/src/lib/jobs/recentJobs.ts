const STORAGE_KEY = 'plexus.recentJobs'
const MAX_ENTRIES = 50

export interface RecentJob {
  jobId: string
  pipelineId: string
  label: string
  createdAt: string
}

// Per-browser job history for the quick-actions flow (TASK-jobs-list-page.md)
// -- there's no auth/user concept in the schema yet, so a server-side list
// would either leak every browser's jobs to every other browser or require
// inventing a user concept prematurely. localStorage also survives a reload,
// which in-memory-only React state would not.
//
// Guarded for SSR: Next.js can execute this module server-side, where
// `window`/`localStorage` don't exist.
function hasStorage(): boolean {
  return typeof window !== 'undefined'
}

export function recordRecentJob(entry: RecentJob): void {
  if (!hasStorage()) return
  const deduped = listRecentJobs().filter((job) => job.jobId !== entry.jobId)
  const next = [entry, ...deduped].slice(0, MAX_ENTRIES)
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function listRecentJobs(): RecentJob[] {
  if (!hasStorage()) return []
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RecentJob[]) : []
  } catch {
    return []
  }
}

export function clearRecentJobs(): void {
  if (!hasStorage()) return
  window.localStorage.removeItem(STORAGE_KEY)
}
