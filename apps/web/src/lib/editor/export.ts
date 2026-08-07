import type { Recipe } from '@/lib/recipe/schema'

// Base URL of the orchestrator API (apps/orchestrator) -- Next.js only
// loads env files from this app's own directory (apps/web/.env.local), not
// the monorepo root's .env.example (that one is infra-only: orchestrator/
// worker vars). See apps/web/.env.example.
const DEFAULT_ORCHESTRATOR_URL = 'http://localhost:3000'

export function orchestratorExportUrl(): string {
  const base = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? DEFAULT_ORCHESTRATOR_URL
  return `${base.replace(/\/$/, '')}/export`
}

// Builds the multipart body apps/orchestrator's POST /export expects: the
// original uploaded File byte-for-byte (never a canvas re-encode -- see
// editor/page.tsx's sourceFile state) plus just the recipe's steps (the
// Go side only needs an ordered processor/params list, not the Recipe
// wrapper's optional name -- workers/internal/render/message.go's
// RecipeStep). Pure and DOM-free beyond FormData/File, which jsdom
// implements, so it's directly unit-testable -- same extraction rationale
// as light-blend.ts/crop-drag.ts.
export function buildExportFormData(file: File, recipe: Recipe): FormData {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('recipe', JSON.stringify(recipe.steps))
  return form
}

// Posts the export request and returns the rendered file as a Blob. Throws
// with the server's own error text on a non-2xx response (workers/cmd/
// renderserver's http.Error bodies, or apps/orchestrator's own 400/502)
// rather than a generic "request failed", since that text is what tells a
// developer *which* recipe step failed.
export async function exportRecipe(
  file: File,
  recipe: Recipe,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  const res = await fetchImpl(orchestratorExportUrl(), {
    method: 'POST',
    body: buildExportFormData(file, recipe),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`export failed (${res.status}): ${text || res.statusText}`)
  }

  return res.blob()
}

// Extension guess for the download's filename -- mirrors
// workers/cmd/renderserver's Content-Type map, since the server names its
// Content-Disposition attachment "export.<ext>" but browsers don't always
// honor that over the anchor's own `download` attribute.
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

export function triggerDownload(blob: Blob, baseName = 'export'): void {
  const ext = EXTENSION_BY_CONTENT_TYPE[blob.type] ?? 'jpeg'
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${baseName}.${ext}`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
