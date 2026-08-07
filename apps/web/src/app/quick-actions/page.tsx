'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Dropzone } from '@/components/Dropzone'
import { Button } from '@/components/ui/button'
import { createJob, createPipelineFromRecipe, uploadFile } from '@/lib/editor/batch'
import { takePendingFile } from '@/lib/pending-file'
import { detectKind, presetsFor, type QuickActionKind } from '@/lib/quick-actions/presets'

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

// The video/audio counterpart to /editor -- presets only, no raw parameter
// controls (docs/tasks/TASK-quick-actions-screen.md, an explicit product
// decision, not a scope cut). A dropped/chosen file gets uploaded and run
// through one named preset's recipe via the same pipeline/job machinery the
// editor's Apply to Batch flow already proved out
// (apps/web/src/lib/editor/batch.ts, reused unmodified).
export default function QuickActionsPage() {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState<QuickActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingPresetId, setPendingPresetId] = useState<string | null>(null)

  function handleFile(picked: File) {
    const detected = detectKind(picked)
    if (!detected) {
      setError(`"${picked.name}" isn't a video or audio file -- for photos, use the editor instead.`)
      return
    }
    setError(null)
    setFile(picked)
    setKind(detected)
  }

  // Picks up a file the home page's drop-zone already captured
  // (apps/web/src/lib/pending-file.ts) so dropping a video/audio file on
  // `/` doesn't force a second drop here. Absent (direct visit, hard
  // refresh) falls through to this page's own empty-state dropzone. A
  // one-shot read of an external module-level stash, not a
  // derivable-from-props value; takePendingFile() self-clears so this can't
  // loop or re-fire on a later render.
  useEffect(() => {
    const pending = takePendingFile()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pending) handleFile(pending)
  }, [])

  function reset() {
    setFile(null)
    setKind(null)
    setError(null)
  }

  async function runPreset(presetId: string) {
    if (!file || !kind) return
    const preset = presetsFor(kind, file.name).find((candidate) => candidate.id === presetId)
    if (!preset) return

    setPendingPresetId(presetId)
    setError(null)
    try {
      const inputRef = await uploadFile(file)
      const pipeline = await createPipelineFromRecipe(
        { steps: preset.steps },
        `${preset.label} -- ${file.name}`,
      )
      const job = await createJob(pipeline.id, inputRef)
      router.push(`/quick-actions/${job.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPendingPresetId(null)
    }
  }

  const presets = kind && file ? presetsFor(kind, file.name) : []

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Link
          href="/"
          className="flex items-center gap-1 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Home
        </Link>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase">
          Quick Actions
        </span>
      </header>

      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
        {error && (
          <p className="border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            {error}
          </p>
        )}

        {!file || !kind ? (
          <Dropzone
            accept="video/*,audio/*"
            label="Drop a video or audio file, or click to choose"
            onFile={handleFile}
            className="min-h-72 w-full"
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border pb-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
                  {kind}
                </span>
                <span className="truncate text-sm text-foreground">{file.name}</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatBytes(file.size)}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={reset} disabled={pendingPresetId !== null}>
                Change file
              </Button>
            </div>

            <div className="flex flex-col">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={pendingPresetId !== null}
                  onClick={() => runPreset(preset.id)}
                  className="group flex items-center justify-between gap-4 border-b border-border py-4 text-left last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase group-hover:text-primary">
                      {preset.label}
                    </span>
                    <span className="text-sm text-muted-foreground">{preset.description}</span>
                  </div>
                  {pendingPresetId === preset.id ? (
                    <span className="shrink-0 font-mono text-[11px] tracking-[0.08em] text-primary uppercase">
                      Starting…
                    </span>
                  ) : (
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
