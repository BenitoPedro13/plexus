import type { Recipe } from '@/lib/recipe/schema'

export type QuickActionKind = 'video' | 'audio'

export interface QuickActionPreset {
  id: string
  label: string
  description: string
  steps: Recipe['steps']
}

// video.compress (workers/internal/processors/video_compress.go) reads its
// output container from the input's file extension and requires it to
// already be mp4/webm -- it errors on anything else rather than
// transcoding first. See docs/tasks/TASK-quick-actions-screen.md "Porquê".
const VIDEO_COMPRESS_CONTAINERS = new Set(['mp4', 'webm'])

function containerExt(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename)
  return match ? match[1].toLowerCase() : ''
}

// Maps a dropped/selected File to which quick-actions flow applies -- null
// for anything else (e.g. an image, which belongs in /editor instead).
export function detectKind(file: File): QuickActionKind | null {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

// The curated, presets-only preset list (no raw parameter controls -- an
// explicit product decision, see docs/tasks/TASK-quick-actions-screen.md).
// "Shrink for sharing" deliberately doesn't promise a target file size --
// video.compress's `quality` is a CRF-style knob (ffmpeg.go's
// videoCrfArgs), not a 2-pass target-bitrate encode, so a literal "under
// 20MB" claim would be a promise the processor can't keep (tracked as a new
// D-xx in docs/90-deferred-register.md).
export function presetsFor(kind: QuickActionKind, filename: string): QuickActionPreset[] {
  if (kind === 'video') {
    const container = containerExt(filename)
    const shrinkSteps: Recipe['steps'] = VIDEO_COMPRESS_CONTAINERS.has(container)
      ? [{ id: 'compress', processor: 'video.compress', params: { quality: 30 } }]
      : [
          { id: 'transcode', processor: 'video.transcode', params: { format: 'mp4', quality: 75 } },
          { id: 'compress', processor: 'video.compress', params: { quality: 30 } },
        ]

    return [
      {
        id: 'shrink',
        label: 'Shrink for sharing',
        description: 'A smaller file with some quality trade-off -- good for messaging apps and email.',
        steps: shrinkSteps,
      },
      {
        id: 'to-mp4',
        label: 'Convert to MP4',
        description: 'The format that plays almost everywhere.',
        steps: [{ id: 'transcode', processor: 'video.transcode', params: { format: 'mp4', quality: 75 } }],
      },
      {
        id: 'to-webm',
        label: 'Convert to WebM',
        description: 'A smaller, web-friendly format.',
        steps: [{ id: 'transcode', processor: 'video.transcode', params: { format: 'webm', quality: 75 } }],
      },
      {
        id: 'extract-audio',
        label: 'Extract audio as MP3',
        description: 'Pull out just the sound as an MP3 file.',
        steps: [{ id: 'extract', processor: 'audio.extract', params: { format: 'mp3', bitrate: 128 } }],
      },
    ]
  }

  return [
    {
      id: 'to-mp3',
      label: 'Convert to MP3',
      description: 'Small file size, plays almost everywhere.',
      steps: [{ id: 'convert', processor: 'audio.convert', params: { format: 'mp3', bitrate: 128 } }],
    },
    {
      id: 'to-wav',
      label: 'Convert to WAV',
      description: 'Uncompressed, full quality.',
      steps: [{ id: 'convert', processor: 'audio.convert', params: { format: 'wav', bitrate: 128 } }],
    },
    {
      id: 'to-aac',
      label: 'Convert to AAC',
      description: 'A compressed format Apple devices favor.',
      steps: [{ id: 'convert', processor: 'audio.convert', params: { format: 'aac', bitrate: 128 } }],
    },
  ]
}
