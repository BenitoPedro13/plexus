import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'
import { SITE_DESCRIPTION } from '@/lib/site'

// Design intent: docs/tasks/TASK-seo-og-metadata.md. Colors are the hex conversion of
// apps/web/src/app/globals.css's "darkroom safelight" OKLCH tokens -- ImageResponse
// (satori/Resvg) doesn't parse oklch(), so these are computed equivalents, not new colors.
const INK = '#16130f' // --background
const PAPER = '#f3ece2' // --foreground
const SAFELIGHT = '#e2551b' // --primary
const PAPER_DIM = '#948c7e' // --muted-foreground

export const OG_IMAGE_SIZE = { width: 1200, height: 630 }
export const OG_IMAGE_ALT = `Plexus -- ${SITE_DESCRIPTION}`
export const OG_IMAGE_CONTENT_TYPE = 'image/png'

// Read once at module scope (predictable, not request-dependent) -- same pattern as the
// Next.js docs' own custom-font ImageResponse example, pointed at the official `geist` npm
// package's static .ttf files instead of a hand-copied asset. This app's --font-heading
// *is* Geist Mono (globals.css), so this is brand identity, not decoration.
const geistMonoDir = join(process.cwd(), 'node_modules/geist/dist/fonts/geist-mono')
const [regular, semibold] = await Promise.all([
  readFile(join(geistMonoDir, 'GeistMono-Regular.ttf')),
  readFile(join(geistMonoDir, 'GeistMono-SemiBold.ttf')),
])

// The Dropzone's "photo-mount" corner-bracket motif (apps/web/src/components/Dropzone.tsx),
// reused at large scale as this image's one signature element.
function CornerBracket({ vertical, horizontal }: { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' }) {
  return (
    <div
      style={{
        position: 'absolute',
        [vertical]: 56,
        [horizontal]: 56,
        width: 64,
        height: 64,
        borderColor: SAFELIGHT,
        borderStyle: 'solid',
        borderTopWidth: vertical === 'top' ? 4 : 0,
        borderBottomWidth: vertical === 'bottom' ? 4 : 0,
        borderLeftWidth: horizontal === 'left' ? 4 : 0,
        borderRightWidth: horizontal === 'right' ? 4 : 0,
      }}
    />
  )
}

export async function renderOgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          backgroundColor: INK,
          fontFamily: 'Geist Mono',
        }}
      >
        <CornerBracket vertical="top" horizontal="left" />
        <CornerBracket vertical="top" horizontal="right" />
        <CornerBracket vertical="bottom" horizontal="left" />
        <CornerBracket vertical="bottom" horizontal="right" />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: 4,
            color: SAFELIGHT,
          }}
        >
          <span>PHOTO</span>
          <span>·</span>
          <span>VIDEO</span>
          <span>·</span>
          <span>AUDIO</span>
        </div>

        <div style={{ display: 'flex', fontSize: 132, fontWeight: 600, color: PAPER, marginTop: 28 }}>
          Plexus
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 28,
            fontWeight: 400,
            color: PAPER_DIM,
            textAlign: 'center',
            maxWidth: 760,
            lineHeight: 1.4,
            marginTop: 20,
          }}
        >
          {SITE_DESCRIPTION}
        </div>
      </div>
    ),
    {
      ...OG_IMAGE_SIZE,
      fonts: [
        { name: 'Geist Mono', data: regular, weight: 400, style: 'normal' },
        { name: 'Geist Mono', data: semibold, weight: 600, style: 'normal' },
      ],
    },
  )
}
