# TASK: Jobs list page (client-tracked, per-browser)

## Cenário actual

There is no way to see more than one job's progress at a time in the quick-actions flow.
`apps/web/src/app/quick-actions/page.tsx`'s `runPreset()` creates exactly one job
(`createJob`) and immediately `router.push`es to `/quick-actions/[jobId]`
(`apps/web/src/app/quick-actions/[jobId]/page.tsx`), a single-job detail view with no link
back to any other job. Starting a second quick action before the first finishes has no
recovery path to the first job's page except the browser's own back button, and there is no
list anywhere of "jobs I've started." Confirmed via `grep -rn "@Get()" apps/orchestrator/src/
jobs/jobs.controller.ts` — the controller only exposes `POST /jobs`, `POST /jobs/batch`,
`GET /jobs/:id`, and `GET /jobs/:id/events`; there is no list endpoint (`GET /jobs`) either.

The `jobs` Postgres table (`apps/orchestrator/src/db/schema.ts:47-62`) has no user/session
column — confirmed by reading the schema directly. There is no auth in this system yet (an
explicit open question in the spec). Adding a server-side `GET /jobs` today would therefore
return *every* job any browser has ever created, with no way to scope it to "mine" — wrong
shape for what's being asked ("a place I can see the jobs I'm awaiting"), and would need
redoing the moment auth exists. Confirmed with the user directly (AskUserQuestion) that the
right scope for now is client-side/per-browser, not a global server list.

The batch flow (`apps/web/src/app/batch/[pipelineId]/page.tsx`) already shows live progress
for a group of jobs created together, driven off a `?jobs=` query-string param
(`applyToBatch` in `apps/web/src/lib/editor/batch.ts`, called from
`apps/web/src/app/editor/page.tsx:193`) — that page already solves "watch several jobs I
just started together" for its own flow. This task is scoped to the gap the user actually
hit: quick-actions jobs, started one at a time, with no memory of previous ones once you
navigate away. Wiring the batch flow's jobs into the same persisted list is a natural
follow-up, not done here — logged in `docs/90-deferred-register.md` as deliberate scope, not
silently dropped.

## Mudanças planeadas

1. **`apps/web/src/lib/jobs/recentJobs.ts`** (new) — a small `localStorage`-backed store,
   guarded for SSR (`typeof window === 'undefined'` no-ops, since this runs in a Next.js app
   directory where modules can execute server-side):
   - `interface RecentJob { jobId: string; pipelineId: string; label: string; createdAt: string }`
   - `recordRecentJob(entry: RecentJob): void` — reads the `plexus.recentJobs` key, prepends
     `entry`, de-dupes by `jobId` (a retried/duplicate `recordRecentJob` call for the same
     job shouldn't create two rows), caps the stored list at 50 entries (oldest dropped) so
     the key can't grow unbounded over a long-lived browser profile, writes back as JSON.
   - `listRecentJobs(): RecentJob[]` — returns the stored list newest-first, `[]` on missing
     key or parse failure (corrupt/foreign localStorage content must not crash the page).
   - `clearRecentJobs(): void` — removes the key; backs a "Clear" action on the list page.
   - `apps/web/src/lib/jobs/recentJobs.test.ts` (new) — unit tests for record/de-dupe/cap/
     list/clear. jsdom's own `localStorage` turned out unreliable under this project's
     installed jsdom/vitest versions (`window.localStorage` came back `undefined` in a real
     run) — used a minimal in-memory `Storage` stand-in stubbed via `vi.stubGlobal`, the same
     precedent `useJobProgress.test.ts`'s `FakeEventSource` already established for a browser
     API jsdom doesn't reliably provide.
2. **`apps/web/src/app/quick-actions/page.tsx`** — `runPreset()` calls `recordRecentJob({
   jobId: job.id, pipelineId: pipeline.id, label: \`${preset.label} — ${file.name}\`,
   createdAt: new Date().toISOString() })` right after `createJob` resolves, before
   `router.push`.
3. **`apps/web/src/app/jobs/page.tsx`** (new) — the list page. Reads `listRecentJobs()` on
   mount (client component). Renders one row per entry: label, relative created-at, and a
   live status badge — each row is a small `JobRow` subcomponent that calls
   `useJobProgress(jobId)` itself (one `EventSource` per visible job; the existing hook
   already handles connect/reconnect/close-on-terminal per id, no changes needed there) and
   links to `/quick-actions/${jobId}`. A "Clear list" button calls `clearRecentJobs()` and
   resets local state. Empty state: "No jobs yet — start one from Quick Actions." Built with
   shadcn primitives already in use elsewhere in this app (`Badge`, `buttonVariants`), same
   status label/variant tables (`JOB_STATUS_LABEL`, `JOB_STATUS_BADGE_VARIANT`) quick-
   actions/[jobId]/page.tsx already uses — no new visual language invented. Per CLAUDE.md,
   loaded the `frontend-design` skill before writing this page's markup.
4. **`apps/web/src/app/page.tsx`** and **`apps/web/src/app/quick-actions/page.tsx`** — header
   gains a small "Jobs" link to `/jobs`, matching the existing header link pattern already
   used for "Home"/"Quick Actions" breadcrumbs.

## Porquê

The user is running multiple quick actions and losing track of the ones not currently on
screen — a real gap, not a nice-to-have, since quick-actions' whole flow is "kick off one
job, get redirected to it," with nothing to come back to. A client-side, per-browser list is
the right shape for the system's current state: no auth exists yet (spec open question), so
a server-side global list would either leak every browser's jobs to every other browser or
require inventing a user/session concept today just to gate a list view — premature scope
for what's actually being asked. `localStorage` also means the list survives a reload, which
an in-memory-only React state would not.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/jobs/recentJobs.ts` | new | `localStorage`-backed record/list/clear for per-browser job tracking |
| `apps/web/src/lib/jobs/recentJobs.test.ts` | new | unit tests: record, de-dupe, cap at 50, list order, clear |
| `apps/web/src/app/quick-actions/page.tsx` | edit | `recordRecentJob()` call after job creation; header gains "Jobs" link |
| `apps/web/src/app/jobs/page.tsx` | new | the jobs list page, live per-row status via `useJobProgress` |
| `apps/web/src/app/page.tsx` | edit | header gains "Jobs" link |
| `docs/90-deferred-register.md` | edit | log batch-flow jobs not yet feeding this same list as deliberate scope (`D-xx`) |
