# TASK: SEO metadata + Open Graph / Twitter share image for `apps/web`

## Cenário actual

`apps/web/src/app/layout.tsx` exports a bare `Metadata` object — just `title: "Plexus"` and
one `description` line. There is no `metadataBase`, no `openGraph`/`twitter` block, no
`robots.txt`, no `sitemap.xml`, and no Open Graph image of any kind. Every route
(`/`, `/editor`, `/jobs`, `/quick-actions`, `/preview-demo`) is a `'use client'` page with no
route-level `layout.tsx`, so all of them currently inherit the identical root title and
description — a shared link to `/editor` and a shared link to `/jobs` render the exact same
unstyled browser-default preview card in Slack/iMessage/Twitter/Discord, with no image.

The production domain was renamed this week to `https://plexus.up.railway.app`
(`docs/tasks/TASK-deploy-railway.md`, `docs/90-deferred-register.md` `D-54` part 2) — that is
the correct canonical URL for every absolute link in this task.

`/preview-demo` is explicitly a dev-only renderer smoke-test harness (see its own file
comment and `apps/web/README.md`'s Pages table) — it should never be indexed.

## Mudanças planeadas

1. **`apps/web/src/lib/site.ts`** (new) — single source of truth for `SITE_URL` (reads
   `NEXT_PUBLIC_SITE_URL`, falls back to `https://plexus.up.railway.app`), `SITE_NAME`
   (`"Plexus"`), and `SITE_DESCRIPTION`, so the copy and URL aren't hand-duplicated across
   `layout.tsx`, `robots.ts`, `sitemap.ts`, and the OG image renderer.

2. **`apps/web/src/app/layout.tsx`** (edit) — expand the `metadata` export: `metadataBase`
   (from `SITE_URL`), `title: { default, template: '%s · Plexus' }`, `keywords`, an
   `openGraph` block (`title`, `description`, `url: '/'`, `siteName`, `locale: 'en_US'`,
   `type: 'website'`), a `twitter` block (`card: 'summary_large_image'`, `title`,
   `description`), and `robots: { index: true, follow: true }`. Deliberately **not** setting
   `openGraph.images`/`twitter.images` by hand — the file-based convention in step 3 injects
   the correct absolute-URL tags automatically and is what the Next.js docs
   (`generate-metadata.md`, "Good to know" under `openGraph`) recommend over hand-syncing.

3. **`apps/web/src/lib/og/render.tsx`** (new) — one shared `renderOgImage()` using
   `ImageResponse` from `next/og`, plus exported `OG_IMAGE_SIZE` (1200×630) and
   `OG_IMAGE_ALT`. Reused verbatim by both file conventions in step 4 so the visual and the
   font-loading logic exist exactly once.

   Design (derived from this app's own existing tokens/motifs, not invented — see
   `apps/web/src/app/globals.css`'s "Darkroom safelight palette" and
   `apps/web/src/components/Dropzone.tsx`'s corner-bracket "photo-mount" motif):
   - Background: ink (`#16130f`, the OKLCH `--background` converted to sRGB — satori/Resvg
     doesn't parse `oklch()`, see `[VERIFY: apps/web/node_modules/next/dist/docs/.../image-response.md
     "Supported HTML and CSS features"]`, confirmed by reading that doc — plain hex/rgb only).
   - The four corner brackets from `Dropzone.tsx`'s empty state, reused at large scale as the
     one signature element (the "photo-mount" frame), in safelight (`#e2551b`).
   - Centered: an uppercase mono eyebrow (`PHOTO · VIDEO · AUDIO`, echoing `AppHeader`'s own
     `·` divider convention) in safelight, the "Plexus" wordmark in paper (`#f3ece2`), and one
     tagline line in paper-dim (`#948c7e`) — matching `SITE_DESCRIPTION`.
   - Typeface: real Geist Mono (Regular + SemiBold static `.ttf`), not satori's unstyled
     fallback — because this app's `--font-heading` *is* Geist Mono
     (`apps/web/src/app/globals.css`), monospace is load-bearing brand identity here, not a
     decorative choice. Sourced from the official `geist` npm package's static font files
     (`node_modules/geist/dist/fonts/geist-mono/*.ttf`) — the same pattern the Next.js docs
     use for custom `ImageResponse` fonts (`readFile(join(process.cwd(), ...))`), just
     pointed at an installed package instead of a hand-copied asset. Two static weights ≈
     290KB combined, comfortably under `ImageResponse`'s 500KB bundle cap.

4. **`apps/web/src/app/opengraph-image.tsx`** and **`apps/web/src/app/twitter-image.tsx`**
   (new) — each just re-exports `size`/`alt`/`contentType` from `lib/og/render.tsx` and
   default-exports `renderOgImage`. Two files instead of relying on Twitter's crawler
   falling back to `og:image` because that fallback behavior isn't documented in this
   project's own Next.js docs snapshot and this repo's rule is "never invent... browser
   capability" — generating both explicitly needs no assumption either way.

5. **`apps/web/src/app/robots.ts`** (new) — `allow: '/'`, `disallow: '/preview-demo'`,
   `sitemap: `${SITE_URL}/sitemap.xml``.

6. **`apps/web/src/app/sitemap.ts`** (new) — lists `/`, `/editor`, `/quick-actions` (the
   three surfaces with evergreen, shareable content). Deliberately excludes `/jobs`
   (per-browser `localStorage` state, no content to index) and `/preview-demo` (already
   disallowed in step 5).

7. **`apps/web/src/app/editor/layout.tsx`, `.../jobs/layout.tsx`,
   `.../quick-actions/layout.tsx`** (new, one line each) — thin Server Component layouts
   whose only job is `export const metadata: Metadata = { title: '...' }`, since each
   route's `page.tsx` is `'use client'` and can't export `metadata` itself. Resolves the
   template from step 2 into e.g. `<title>Editor · Plexus</title>`.

8. **`apps/web/src/app/preview-demo/layout.tsx`** (new) — same shape, `title: 'Preview
   Renderer Demo'` **and** `robots: { index: false, follow: false }` — belt-and-suspenders
   with step 5's `disallow`, since a direct link to a disallowed-but-unindexed page should
   still carry its own noindex if ever crawled some other way (e.g. followed from an
   external link rather than site crawl).

9. **`apps/web/package.json`** (edit, via `pnpm add geist`, not hand-edited) — adds `geist`
   as a direct dependency for step 3's font files.

10. **`apps/web/.env.example`** (edit) — documents the new optional `NEXT_PUBLIC_SITE_URL`
    var alongside the existing `NEXT_PUBLIC_ORCHESTRATOR_URL`.

11. **`apps/web/README.md`** (edit) — short "SEO & sharing" section: what's generated, where
    the OG image's design intent lives, and the `NEXT_PUBLIC_SITE_URL` env var.

12. **`docs/90-deferred-register.md`** (edit) — one new `D-xx`: `SITE_URL` defaults to the
    production domain with no separate staging/preview `metadataBase` handling, because the
    project has no staging environment yet (only local dev and the one Railway production
    deploy). Revisit if a preview/staging environment is ever added.

## Porquê

A link to `plexus.up.railway.app` shared in Slack/iMessage/Discord/Twitter today renders as
a bare blue link or a generic empty-card fallback — the single most common way a small
project actually gets seen for the first time. This is a standard, low-risk, well-scoped
piece of "make the product presentable to the outside world" work, using only Next.js's own
documented file conventions (`opengraph-image`, `twitter-image`, `robots.ts`, `sitemap.ts`)
rather than any hand-rolled meta-tag assembly. The OG image reuses the app's *existing*
visual identity (darkroom-safelight palette, photo-mount corner brackets, Geist Mono) rather
than introducing a new one, so the shared link actually looks like the product rather than a
generic template card.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/site.ts` | new | `SITE_URL`/`SITE_NAME`/`SITE_DESCRIPTION` |
| `apps/web/src/lib/og/render.tsx` | new | shared `ImageResponse` renderer, Geist Mono via `geist` pkg |
| `apps/web/src/app/opengraph-image.tsx` | new | file-based OG image convention |
| `apps/web/src/app/twitter-image.tsx` | new | file-based Twitter card image convention |
| `apps/web/src/app/robots.ts` | new | disallows `/preview-demo`, points at sitemap |
| `apps/web/src/app/sitemap.ts` | new | `/`, `/editor`, `/quick-actions` |
| `apps/web/src/app/layout.tsx` | edit | `metadataBase`, title template, `openGraph`/`twitter`/`robots` |
| `apps/web/src/app/editor/layout.tsx` | new | route title only |
| `apps/web/src/app/jobs/layout.tsx` | new | route title only |
| `apps/web/src/app/quick-actions/layout.tsx` | new | route title only |
| `apps/web/src/app/preview-demo/layout.tsx` | new | route title + `noindex` |
| `apps/web/package.json` | edit | `+geist` dep (via `pnpm add`) |
| `apps/web/.env.example` | edit | document `NEXT_PUBLIC_SITE_URL` |
| `apps/web/README.md` | edit | "SEO & sharing" section |
| `docs/90-deferred-register.md` | edit | new `D-xx`: no staging `metadataBase` yet |
