'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { AppHeader, JobsLink } from '@/components/AppHeader'
import { Dropzone } from '@/components/Dropzone'
import { Button } from '@/components/ui/button'
import { createJob, createPipelineFromRecipe, uploadFile } from '@/lib/editor/batch'
import { recordRecentJob } from '@/lib/jobs/recentJobs'
import { setPendingFile, takePendingFile } from '@/lib/pending-file'
import { detectKind, presetsFor, type QuickActionKind, type QuickActionPreset } from '@/lib/quick-actions/presets'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

const KIND_LABEL: Record<QuickActionKind, string> = { image: 'Photo', video: 'Video', audio: 'Audio' }
const KIND_NOUN: Record<QuickActionKind, string> = { image: 'photo', video: 'video', audio: 'audio' }
const KIND_ACCEPT: Record<QuickActionKind, string> = { image: 'image/*', video: 'video/*', audio: 'audio/*' }

const KIND_TILES: { kind: QuickActionKind; blurb: string }[] = [
  { kind: 'image', blurb: 'Edit, convert, or compress a photo.' },
  { kind: 'video', blurb: 'Shrink, convert, or pull the audio out of a video.' },
  { kind: 'audio', blurb: 'Convert an audio file to another format.' },
]

function isQuickActionKind(value: string | null): value is QuickActionKind {
  return value === 'image' || value === 'video' || value === 'audio'
}

// Action-first: this page always shows what it can do before it asks for a
// file. Three states, threaded through the URL (?kind=&action=) so back/
// forward and bookmarking behave, plus local `file` state (a File can't
// live in a URL): no kind -> kind picker; kind, no action -> that kind's
// catalog (image's catalog includes "Edit", which isn't a run-a-job preset
// -- it hands off to /editor); kind + action, no file -> a dropzone scoped
// to that one action. A file already in hand (dropped on home's hero, or
// dropped into the scoped dropzone) always runs immediately -- no separate
// confirmation step. See docs/tasks/TASK-action-first-navigation.md.
export default function QuickActionsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const kindParam = searchParams.get('kind')
  const kind = isQuickActionKind(kindParam) ? kindParam : null
  const actionId = searchParams.get('action')

  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)

  // Picks up a file the home page's hero dropzone already captured
  // (apps/web/src/lib/pending-file.ts) so dropping a file on `/` doesn't
  // force a second drop here. Always lands on that file's kind's catalog
  // (dropping any in-flight ?action=, even if the URL already had one) --
  // the point is to show the menu before anything runs, for this fast path
  // too. One-shot: takePendingFile() self-clears.
  useEffect(() => {
    const pending = takePendingFile()
    if (!pending) return
    const detected = detectKind(pending)
    if (!detected) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFile(pending)
    router.replace(`/quick-actions?kind=${detected}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A stale/hand-edited ?action= that doesn't match any of this kind's
  // presets falls back to the catalog view below; this just tidies the URL
  // to match what's actually being shown.
  useEffect(() => {
    if (!kind || !actionId) return
    const stub = presetsFor(kind, '').find((candidate) => candidate.id === actionId)
    if (!stub) router.replace(`/quick-actions?kind=${kind}`)
  }, [kind, actionId, router])

  function reset() {
    setFile(null)
    setError(null)
  }

  async function runAction(preset: QuickActionPreset, targetFile: File) {
    setPendingActionId(preset.id)
    setError(null)
    try {
      const inputRef = await uploadFile(targetFile)
      const pipeline = await createPipelineFromRecipe(
        { steps: preset.steps },
        `${preset.label} -- ${targetFile.name}`,
      )
      const job = await createJob(pipeline.id, inputRef)
      recordRecentJob({
        jobId: job.id,
        pipelineId: pipeline.id,
        label: `${preset.label} -- ${targetFile.name}`,
        createdAt: new Date().toISOString(),
      })
      router.push(`/quick-actions/${job.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPendingActionId(null)
    }
  }

  function chooseAction(kindValue: QuickActionKind, preset: QuickActionPreset) {
    if (file) {
      void runAction(preset, file)
      return
    }
    router.push(`/quick-actions?kind=${kindValue}&action=${preset.id}`)
  }

  function chooseEdit() {
    if (file) setPendingFile(file)
    router.push('/editor')
  }

  function handleScopedFile(kindValue: QuickActionKind, chosenActionId: string, picked: File) {
    const detected = detectKind(picked)
    if (detected !== kindValue) {
      setError(`"${picked.name}" isn't a ${KIND_NOUN[kindValue]} file.`)
      return
    }
    setError(null)
    setFile(picked)
    const preset = presetsFor(kindValue, picked.name).find((candidate) => candidate.id === chosenActionId)
    if (preset) void runAction(preset, picked)
  }

  // No kind chosen yet -- fallback for a direct/bookmarked visit; every
  // in-app link (home's kind cards, the hero dropzone) sets ?kind= itself.
  if (!kind) {
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <AppHeader crumbs={[{ label: 'Home', href: '/' }, { label: 'Quick Actions' }]} right={<JobsLink />} />
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-10">
          {KIND_TILES.map(({ kind: tileKind, blurb }) => (
            <Link
              key={tileKind}
              href={`/quick-actions?kind=${tileKind}`}
              className="group flex items-center justify-between gap-4 border-b border-border py-4 last:border-b-0"
            >
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase group-hover:text-primary">
                  {KIND_LABEL[tileKind]}
                </span>
                <span className="text-sm text-muted-foreground">{blurb}</span>
              </div>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
            </Link>
          ))}
        </div>
      </div>
    )
  }

  // Kind + action chosen, no file yet: a dropzone scoped to that one action.
  // An unrecognized ?action= (stale/hand-edited URL) has no stub to match,
  // so it falls through to the catalog view below instead.
  if (actionId && !file) {
    const stub = presetsFor(kind, '').find((candidate) => candidate.id === actionId)
    if (stub) {
      return (
        <div className="flex min-h-screen flex-col bg-background text-foreground">
          <AppHeader
            crumbs={[
              { label: 'Home', href: '/' },
              { label: KIND_LABEL[kind], href: `/quick-actions?kind=${kind}` },
              { label: stub.label },
            ]}
            right={<JobsLink />}
          />
          <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
            {error && (
              <p className="border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
                {error}
              </p>
            )}
            <Dropzone
              accept={KIND_ACCEPT[kind]}
              label={`Drop a ${KIND_NOUN[kind]} file to ${stub.label.toLowerCase()}`}
              onFile={(picked) => handleScopedFile(kind, actionId, picked)}
              className="min-h-72 w-full"
            />
          </div>
        </div>
      )
    }
  }

  // Kind chosen, catalog view: everything this kind can do, before (or
  // alongside, once one's already in hand) a file.
  const presets = presetsFor(kind, file?.name ?? '')
  const rows: { id: string; label: string; description: string; onSelect: () => void }[] = [
    ...(kind === 'image'
      ? [
          {
            id: 'edit',
            label: 'Edit',
            description: 'Crop, adjust light and color, and export -- opens the full editor.',
            onSelect: chooseEdit,
          },
        ]
      : []),
    ...presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      onSelect: () => chooseAction(kind, preset),
    })),
  ]

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Quick Actions', href: '/quick-actions' },
          { label: KIND_LABEL[kind] },
        ]}
        right={<JobsLink />}
      />

      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
        {error && (
          <p className="border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            {error}
          </p>
        )}

        {file && (
          <div className="flex items-center justify-between gap-3 border-b border-border pb-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
                {KIND_LABEL[kind]}
              </span>
              <span className="truncate text-sm text-foreground">{file.name}</span>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={reset} disabled={pendingActionId !== null}>
              Change file
            </Button>
          </div>
        )}

        <div className="flex flex-col">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              disabled={pendingActionId !== null}
              onClick={row.onSelect}
              className="group flex items-center justify-between gap-4 border-b border-border py-4 text-left last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase group-hover:text-primary">
                  {row.label}
                </span>
                <span className="text-sm text-muted-foreground">{row.description}</span>
              </div>
              {pendingActionId === row.id ? (
                <span className="shrink-0 font-mono text-[11px] tracking-[0.08em] text-primary uppercase">
                  Starting…
                </span>
              ) : (
                <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
