'use client'

import { useState } from 'react'
import { UploadCloud } from 'lucide-react'

interface DropzoneProps {
  accept: string
  label: string
  onFile: (file: File) => void
  className?: string
}

const CORNER_CLASSES = [
  'top-0 left-0 border-t-2 border-l-2',
  'top-0 right-0 border-t-2 border-r-2',
  'bottom-0 left-0 border-b-2 border-l-2',
  'bottom-0 right-0 border-b-2 border-r-2',
] as const

// Shared corner-bracket "photo-mount" dropzone -- the empty-state motif from
// docs/tasks/TASK-editor-visual-design.md, extracted for reuse once the home
// page and the quick-actions screen needed the same "drop a file" gesture
// (docs/tasks/TASK-home-page.md, TASK-quick-actions-screen.md). Behavior is
// unchanged from the editor's original inline version -- only lifted out and
// parameterized by accept/label/onFile.
export function Dropzone({ accept, label, onFile, className }: DropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setIsDragOver(false)
    const file = event.dataTransfer.files?.[0]
    if (file) onFile(file)
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onFile(file)
  }

  return (
    <label
      className={`relative flex cursor-pointer items-center justify-center rounded-sm ${className ?? ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <input type="file" accept={accept} className="sr-only" onChange={handleChange} />
      <div className="pointer-events-none absolute inset-6">
        {CORNER_CLASSES.map((corner) => (
          <span
            key={corner}
            className={`absolute h-6 w-6 ${corner} ${isDragOver ? 'border-primary' : 'border-muted-foreground/40'}`}
          />
        ))}
      </div>
      <div className="flex flex-col items-center gap-3 text-center">
        <UploadCloud className={isDragOver ? 'size-6 text-primary' : 'size-6 text-muted-foreground'} />
        <p className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </p>
      </div>
    </label>
  )
}
