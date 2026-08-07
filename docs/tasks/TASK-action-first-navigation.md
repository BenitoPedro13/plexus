# TASK: Action-first navigation (catalog before file, Jobs everywhere)

## Cenário actual

The user hit three real navigation gaps using the app as it stands today:

1. **Jobs is only reachable from `/` and `/quick-actions`.** Both headers link to
   `/jobs` (`apps/web/src/app/page.tsx:66`, `apps/web/src/app/quick-actions/page.tsx:113`),
   but `apps/web/src/app/editor/page.tsx` (header at line 210), `apps/web/src/app/
   quick-actions/[jobId]/page.tsx` (header at line 54), and `apps/web/src/app/batch/
   [pipelineId]/page.tsx` (header at line 135) have no link to `/jobs` at all — confirmed via
   `grep -rn "href=\"/jobs\""`. Once you're on any of those three pages there is no way back
   to the jobs list except the browser's back button or typing the URL by hand. The user
   flagged this directly.

2. **`/quick-actions` is file-first, not action-first.** `QuickActionsPage` (`apps/web/src/
   app/quick-actions/page.tsx`) renders a bare `Dropzone` as its *only* content until a file
   is chosen; `presetsFor()` (`apps/web/src/lib/quick-actions/presets.ts:38`) — the list of
   things you can actually do to the file — is only called, and only rendered, after
   `handleFile()` has already captured one. There is no way to see "what can I do with a
   video" without first committing a specific file. The user flagged this directly:
   "the input for video appears before I know what I can do with the video."

3. **Images have no action catalog at all.** `detectKind()` (`apps/web/src/lib/quick-actions/
   presets.ts:25`) only recognizes `video/*` and `audio/*` — an image returns `null` and is
   never routed through the preset system. Home's `handleFile()` (`apps/web/src/app/
   page.tsx:45`) sends every image straight to `/editor`, the full non-destructive editor.
   But `image.convert` and `image.compress` are already real, working processors
   (`packages/recipe/src/schema.ts:8-9`, params confirmed at lines 31-43: `convertParamsSchema
   { format: 'jpeg'|'png'|'webp'|'avif', quality }`, `compressParamsSchema { quality }`) —
   nothing in the UI exposes "just convert this to PNG" or "just shrink this photo" without
   opening the full editor. The user flagged this directly: "for image I don't even see file
   conversion or anything, I go directly to the editor."

Confirmed with the user (`AskUserQuestion`) that the fix keeps the home page light — a hero
dropzone plus one card per kind (Photo / Video / Audio) — rather than dumping the full
action catalog onto `/`. Each kind's catalog lives one click in, on `/quick-actions`, and is
reachable with **no file provided yet**.

## Mudanças planeadas

1. **`apps/web/src/components/AppHeader.tsx`** (new) — extracts the repeated header markup
   (`<header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">`
   + breadcrumb links + trailing slot) that today is hand-copied across `page.tsx`,
   `quick-actions/page.tsx`, `quick-actions/[jobId]/page.tsx`, `batch/[pipelineId]/page.tsx`,
   `jobs/page.tsx`, and `editor/page.tsx` with small drifts between copies (editor's has no
   back-link at all; two of the five have no Jobs link). Props: `crumbs: { label: string;
   href?: string }[]` (all but the last are rendered as links; the first gets the
   `ArrowLeft` icon; a bare one-item list — home's case — renders as a plain non-link label,
   matching today's "Plexus" wordmark) and `right?: ReactNode` for page-specific trailing
   content. Also exports a small `JobsLink` piece (`<Link href="/jobs">Jobs</Link>` in the
   existing muted/mono/uppercase style) so every page's `right` slot can compose it in
   alongside its own actions instead of every page re-declaring the class string.

2. **`apps/web/src/lib/quick-actions/presets.ts`** (edit) —
   - `QuickActionKind` gains `'image'`.
   - `detectKind()` gains an `image/*` branch returning `'image'` (currently falls through
     to `null`, which is what routes every image straight past this whole module).
   - `presetsFor('image', filename)` returns two run-a-job presets, mirroring the existing
     video/audio shape: `{ id: 'convert-jpeg', label: 'Convert to JPEG', steps: [{ id:
     'convert', processor: 'image.convert', params: { format: 'jpeg', quality: 85 } }] }`
     (and `-png`, `-webp` siblings), and `{ id: 'compress', label: 'Compress', description:
     '...', steps: [{ id: 'compress', processor: 'image.compress', params: { quality: 70 } }]
     }`. **"Edit" is deliberately not a preset** — it doesn't create a job, it navigates to
     `/editor` — so it's handled as a distinct, non-`presetsFor` catalog entry in the page
     component, not folded into this data shape.

3. **`apps/web/src/app/quick-actions/page.tsx`** (rewrite) — becomes a small state machine
   driven by a `kind` search param (`useSearchParams`) plus local `actionId`/`file` state:
   - **No `kind` in the URL** (direct/bookmarked visit to `/quick-actions`): render a
     3-tile kind picker (Photo / Video / Audio) — the fallback path; normally you arrive
     with `kind` already set from a home card or hero-drop.
   - **`kind` set, no action chosen yet**: render that kind's catalog — `presetsFor(kind,
     …)` rows, plus, for `kind === 'image'`, a prepended "Edit" row (crop/light/color/
     sharpen, opens the full editor) styled as the primary/first entry. No file has been
     provided at this point — this is the step that closes gap #2 and #3. Clicking "Edit"
     navigates straight to `/editor` (which self-serves an empty-state dropzone if no
     pending file is queued, per `takePendingFile()` — no change needed there). Clicking any
     other row sets `actionId` and, if a file was already captured (see below), runs
     immediately; otherwise advances to the next state.
   - **`kind` + `actionId` set, no file yet**: a scoped `Dropzone` — "Drop a {video|audio|
     photo} file to {action label}" — plus a "← choose a different action" link back to the
     catalog state.
   - **File present** (either just dropped in the state above, or picked up via
     `takePendingFile()` on mount — the existing fast path from home's hero dropzone): runs
     immediately — `uploadFile` → `createPipelineFromRecipe` → `createJob` → `recordRecentJob`
     → `router.push('/quick-actions/${job.id}')`, unchanged from today's `runPreset()` body.
     Picking up a pending file no longer auto-runs a guessed preset — it lands on the
     catalog state with the file already attached, so the first click after arriving *is*
     the action choice, which is what closes gap #2 for the hero-drop path too.
   - Uses `AppHeader` with crumbs `Home → {kind label} → {action label, once chosen}` and
     `right={<JobsLink />}`.

4. **`apps/web/src/app/page.tsx`** (edit) — `TOOL_CARDS`' two entries (`Edit a Photo`,
   `Process Video or Audio`) become three: **Photo**, **Video**, **Audio**, each linking to
   `/quick-actions?kind=image|video|audio` (no file, catalog-first). `handleFile()` (the hero
   dropzone's drop handler) stops special-casing images to `/editor` directly — for every
   kind it now does `setPendingFile(file); router.push(\`/quick-actions?kind=${kind}\`)`,
   using the same `detectKind()` from `presets.ts` (now image-aware) instead of the current
   ad-hoc `file.type.startsWith('image/')` check. This is what closes gap #3: an image dropped
   on the hero now lands on the Photo catalog (Edit / Convert / Compress) instead of jumping
   straight into the full editor. Header switches to `AppHeader`.

5. **`apps/web/src/app/editor/page.tsx`** (edit) — header switches to `AppHeader` with
   crumbs `Home → Editor`; existing Undo/Redo/Apply-to-Batch/Export buttons stay as-is in
   `right`, with `<JobsLink />` appended after them. No change to editor logic — this file's
   edit is header markup only.

6. **`apps/web/src/app/quick-actions/[jobId]/page.tsx`** (edit) — header switches to
   `AppHeader` (crumbs `Quick Actions → Job`, unchanged target), adds `<JobsLink />` to
   `right` (currently absent — this is one of the two pages gap #1 is about).

7. **`apps/web/src/app/batch/[pipelineId]/page.tsx`** (edit) — same treatment: `AppHeader`,
   adds `<JobsLink />` to `right` (also currently absent).

8. **`apps/web/src/app/jobs/page.tsx`** (edit) — header switches to `AppHeader` (crumbs
   `Home → Jobs`), existing conditional `Clear` button stays as `right`. Purely mechanical;
   no visual change.

9. **`docs/90-deferred-register.md`** — log the kind-picker fallback state (item 3, first
   bullet) as deliberate scope: it only exists for a direct/bookmarked `/quick-actions` visit
   with no `kind`, which isn't a path any in-app link produces after this change, so it isn't
   getting the same design attention as the two real catalogs. Also log that the "Edit" row's
   position/styling as the image catalog's primary entry is a first-pass call, not
   user-tested against the two run-a-job rows below it.

## Porquê

All three gaps were reported directly by the user while using the app, not inferred —
`/jobs` unreachable from three of six pages, `/quick-actions` demanding a file before
showing what it can do, and images skipping the action catalog entirely despite the
processors it would need (`image.convert`, `image.compress`) already existing and working.
Fixing them is a navigation/IA change, not a visual restyle, which is why it gets a task doc
under CLAUDE.md §1 before any file is touched, and why `AskUserQuestion` was used to settle
the one real fork (catalog on the home page itself vs. one click in) before writing this
plan — the user picked "one click in" to keep the home page calm.

Folding image quick actions into the same `presets.ts`/`/quick-actions` machinery that
already serves video/audio — rather than inventing a parallel "photo quick actions" screen —
is the recipe/pipeline-unification instinct CLAUDE.md calls out (§0 "Things that must not
break"): one action-catalog system, three kinds, not three bespoke ones.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/components/AppHeader.tsx` | new | shared breadcrumb header + `JobsLink`, replaces six hand-copied headers |
| `apps/web/src/lib/quick-actions/presets.ts` | edit | `'image'` kind, image-aware `detectKind()`, `presetsFor('image', …)` (convert JPEG/PNG/WebP, compress) |
| `apps/web/src/app/quick-actions/page.tsx` | edit (large) | catalog-first state machine: kind picker → action catalog → scoped dropzone → run |
| `apps/web/src/app/page.tsx` | edit | 3 kind cards (Photo/Video/Audio) replace 2 tool cards; hero drop routes every kind through the catalog |
| `apps/web/src/app/editor/page.tsx` | edit | header only — `AppHeader`, adds Jobs link |
| `apps/web/src/app/quick-actions/[jobId]/page.tsx` | edit | header only — `AppHeader`, adds Jobs link (currently missing) |
| `apps/web/src/app/batch/[pipelineId]/page.tsx` | edit | header only — `AppHeader`, adds Jobs link (currently missing) |
| `apps/web/src/app/jobs/page.tsx` | edit | header only — `AppHeader`, mechanical |
| `docs/90-deferred-register.md` | edit | log kind-picker fallback scope + "Edit" row styling as first-pass, unresearched |
