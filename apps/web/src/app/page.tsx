'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Film, Image as ImageIcon } from 'lucide-react'
import { Dropzone } from '@/components/Dropzone'
import { detectKind } from '@/lib/quick-actions/presets'
import { setPendingFile } from '@/lib/pending-file'

interface ToolCard {
  href: string
  icon: typeof ImageIcon
  label: string
  description: string
}

const TOOL_CARDS: ToolCard[] = [
  {
    href: '/editor',
    icon: ImageIcon,
    label: 'Edit a Photo',
    description: 'Crop, adjust light and color, and export instantly.',
  },
  {
    href: '/quick-actions',
    icon: Film,
    label: 'Process Video or Audio',
    description: 'Shrink a video, convert formats, or pull out the audio track.',
  },
]

// The app's front door -- previously a bare redirect("/editor")
// (docs/90-deferred-register.md D-45, superseded by this task). Reusing the
// editor's corner-bracket dropzone as the hero keeps the direct,
// drop-a-file gesture as the default, while the two cards below make
// video/audio processing discoverable -- it has no live-preview editor of
// its own (unlike photos), so a plain drop-anything page would either
// imply a preview experience that doesn't exist or bury the tool entirely.
// See docs/tasks/TASK-home-page.md.
export default function Home() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  function handleFile(file: File) {
    if (file.type.startsWith('image/')) {
      setPendingFile(file)
      router.push('/editor')
      return
    }
    if (detectKind(file)) {
      setPendingFile(file)
      router.push('/quick-actions')
      return
    }
    setError(`"${file.name}" isn't a photo, video, or audio file Plexus can work with.`)
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center px-4">
        <span className="font-mono text-[11px] tracking-[0.08em] text-foreground uppercase">
          Plexus
        </span>
        <Link
          href="/jobs"
          className="ml-auto font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
        >
          Jobs
        </Link>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
        {error && (
          <p className="w-full border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            {error}
          </p>
        )}

        <Dropzone
          accept="image/*,video/*,audio/*"
          label="Drop a file, or pick a tool below"
          onFile={handleFile}
          className="min-h-72 w-full"
        />

        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          {TOOL_CARDS.map(({ href, icon: Icon, label, description }) => (
            <Link
              key={href}
              href={href}
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
