# Plexus editor (apps/web)

Next.js frontend — the non-destructive, Apple-Photos-style image editor described in the
root [`README.md`](../../README.md) and
[`docs/plexus-media-pipeline-spec.md`](../../docs/plexus-media-pipeline-spec.md). Every
adjustment writes recipe parameters; nothing is ever applied to pixels until export.

## Pages

| Route | Purpose |
|---|---|
| `/` | Home page — drop a photo/video/audio file (routed to the right kind's catalog automatically) or pick one of the three kind cards below |
| `/quick-actions` | Action-first catalog, one per kind (`?kind=image\|video\|audio`): shows every named preset for that kind (convert, compress, shrink, extract audio) before asking for a file; the image catalog's "Edit" row hands off to `/editor` for full non-destructive editing. No raw parameter controls — presets only. |
| `/editor` | The full editor surface — drop/select a photo, adjust via curated Light/Color/Black & White/Sharpen/Crop controls, undo/redo, export, Apply to Batch |
| `/batch/[pipelineId]` | Progress/download view for a batch job created by the editor's Apply to Batch flow |
| `/quick-actions/[jobId]` | Progress/download view for a single job created by `/quick-actions` |
| `/jobs` | Per-browser list of jobs started from `/quick-actions` (tracked client-side in `localStorage` — no server-side job list exists), live status via SSE |
| `/preview-demo` | Renderer smoke-test harness — raw per-parameter controls against the `PreviewRenderer` (WebGPU/WebGL2) directly, not the curated editor UI |

## Live preview

`src/lib/preview/` implements two renderers (`WebGPURenderer`, `WebGL2Renderer`) behind one
`PreviewRenderer` interface, with runtime `navigator.gpu` feature detection choosing which
one runs. Both consume the same `Recipe` and apply its steps in true recipe order — no
translation step between what the editor shows and what `workers/`'s Go renderer later
produces at export.

## SEO & sharing

`src/app/layout.tsx` sets `metadataBase`, a title template (`%s · Plexus`), and
`openGraph`/`twitter`/`robots` metadata. `src/app/opengraph-image.tsx` and
`twitter-image.tsx` both render a shared, generated share image
(`src/lib/og/render.tsx`) — the design deliberately reuses this app's own darkroom-safelight
palette, the `Dropzone` corner-bracket "photo-mount" motif, and real Geist Mono (via the
`geist` npm package's static font files) rather than a generic template card. `robots.ts`
and `sitemap.ts` cover `/`, `/editor`, and `/quick-actions`, and exclude the per-browser
`/jobs` list and the dev-only `/preview-demo` harness. See
`docs/tasks/TASK-seo-og-metadata.md` for the full rationale.

`/editor`, `/jobs`, and `/quick-actions` each get a thin `layout.tsx` purely to set their
own `<title>`, since their `page.tsx` is `'use client'` and can't export `metadata` itself.

## Env vars

```sh
cp .env.example .env.local
```

`NEXT_PUBLIC_ORCHESTRATOR_URL` — base URL of `apps/orchestrator`'s API, used by
`src/lib/editor/export.ts` to `POST /export`. Next.js only loads env files from this app's
own directory, not the monorepo root's `.env.example` (that one is infra-only:
orchestrator/worker vars).

`NEXT_PUBLIC_SITE_URL` — optional; canonical site URL for `metadataBase`, absolute
OG/Twitter image URLs, and `robots.txt`/`sitemap.xml`. Defaults to the production domain
(`src/lib/site.ts`) if unset.

## Run

```sh
pnpm install
pnpm dev
```

Open [http://localhost:3001](http://localhost:3001) (bumped from Next's default 3000 to
avoid colliding with `apps/orchestrator`, which also defaults to 3000). Export and
Apply to Batch require a running `apps/orchestrator` and `workers/cmd/renderserver` (see
their own READMEs).

## Test

```sh
pnpm test        # vitest — pure logic + DOM-level tests, no browser/GPU required
pnpm lint
```

Shader source itself (WGSL/GLSL) isn't exercised by this suite — see
`docs/90-deferred-register.md` `D-34` for what that gap has already caused and the
mitigation plan.
