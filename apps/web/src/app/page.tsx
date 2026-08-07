'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, AudioLines, Film, Image as ImageIcon } from 'lucide-react'
import { AppHeader, JobsLink } from '@/components/AppHeader'
import { Dropzone } from '@/components/Dropzone'
import { detectKind, type QuickActionKind } from '@/lib/quick-actions/presets'
import { setPendingFile } from '@/lib/pending-file'

interface KindCard {
  kind: QuickActionKind
  icon: typeof ImageIcon
  label: string
  description: string
}

// One card per kind, each leading to that kind's action catalog on
// /quick-actions (no file needed yet) rather than straight into a single
// tool -- see docs/tasks/TASK-action-first-navigation.md: the user
// shouldn't have to drop a file before finding out a photo can be
// converted or compressed, not just opened in the full editor.
const KIND_CARDS: KindCard[] = [
  {
    kind: 'image',
    icon: ImageIcon,
    label: 'Photo',
    description: 'Edit non-destructively, convert formats, or compress.',
  },
  {
    kind: 'video',
    icon: Film,
    label: 'Video',
    description: 'Shrink for sharing, convert formats, or pull out the audio.',
  },
  {
    kind: 'audio',
    icon: AudioLines,
    label: 'Audio',
    description: 'Convert between MP3, WAV, and AAC.',
  },
]

// The app's front door -- previously a bare redirect("/editor")
// (docs/90-deferred-register.md D-45, superseded by this task). Reusing the
// editor's corner-bracket dropzone as the hero keeps the direct,
// drop-a-file gesture as the default, while the cards below make every
// kind's action catalog discoverable without dropping anything first. See
// docs/tasks/TASK-home-page.md and TASK-action-first-navigation.md.
export default function Home() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  function handleFile(file: File) {
    const kind = detectKind(file)
    if (!kind) {
      setError(`"${file.name}" isn't a photo, video, or audio file Plexus can work with.`)
      return
    }
    setPendingFile(file)
    router.push(`/quick-actions?kind=${kind}`)
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader crumbs={[{ label: 'Plexus' }]} right={<JobsLink />} />

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
        {error && (
          <p className="w-full border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            {error}
          </p>
        )}

        <Dropzone
          accept="image/*,video/*,audio/*"
          label="Drop a file, or pick what you want to do below"
          onFile={handleFile}
          className="min-h-72 w-full"
        />

        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
          {KIND_CARDS.map(({ kind, icon: Icon, label, description }) => (
            <Link
              key={kind}
              href={`/quick-actions?kind=${kind}`}
              className="group flex flex-col gap-2 rounded-sm border border-border p-4 transition-colors hover:border-primary hover:bg-accent"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground group-hover:text-primary" />
                <span className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase">
                  {label}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{description}</p>
              <ArrowRight className="size-3.5 text-muted-foreground group-hover:text-primary" />
            </Link>
          ))}
        </div>

        <p className="text-center text-sm text-muted-foreground">
          Already have an edit you like? Apply it to a whole folder from inside the editor.
        </p>
      </div>
    </div>
  )
}
