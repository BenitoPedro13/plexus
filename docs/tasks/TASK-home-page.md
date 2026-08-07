# TASK: Home page (drop-zone + feature shortcuts)

**Depends on:** `docs/tasks/TASK-quick-actions-screen.md` — this task's shortcut cards link
to `/quick-actions`, which doesn't exist until that task lands. Build/land that one first,
or at minimum in the same pass.

## Cenário actual

`apps/web/src/app/page.tsx` is a bare `redirect("/editor")`. It replaced the unedited
`create-next-app` scaffold same-day (`docs/90-deferred-register.md` `D-45`), on the
reasoning that *"no landing-page concept exists anywhere in the spec — the editor is the
primary (only) surface."* That was true at the time: the only other route was
`/batch/[pipelineId]`, itself only reachable from inside the editor.

That's no longer true once `TASK-quick-actions-screen.md` lands: the app will have two
independent entry points (`/editor` for photos, `/quick-actions` for video/audio) plus the
batch flow, and nothing links them together or explains what each does. A user landing on
`/` today gets dropped straight into the photo editor with zero indication video/audio
tools exist.

## Mudanças planeadas

1. **`apps/web/src/app/page.tsx`** (edit) — replace the `redirect()` with a real page:
   - A centered drop-zone as the primary element (reusing the existing dropzone visual
     pattern/styling already built for `apps/web/src/app/editor/page.tsx`, not new
     markup/CSS, per `frontend-design:frontend-design` skill + shadcn conventions). Accepts
     any file; on drop/select, branches by `file.type`:
       - `image/*` → hand off to `/editor`
       - `video/*` or `audio/*` → hand off to `/quick-actions`
     `[VERIFY during implementation]`: Next.js routing can't pass a `File` object through a
     route transition directly. Decide the hand-off mechanism before writing this —
     candidates: (a) hold the file in a small client-side store (e.g. a module-level
     variable or `sessionStorage`-backed reference) that the destination page checks on
     mount, falling back to its own empty state if absent (e.g. after a hard refresh); (b)
     skip auto-hand-off entirely and just navigate, requiring a second file pick on the
     destination page. Pick the option that doesn't regress the destination pages' existing
     "drop a file directly on `/editor`" behavior, which must keep working standalone.
   - Below the drop-zone, 2–3 shortcut cards for paths a plain drop won't reveal:
     "Edit a Photo" (→ `/editor`), "Compress or Convert Video/Audio" (→ `/quick-actions`).
     A third card for batch ("Apply an edit to many files at once") most likely just deep-
     links to `/editor` with a short explanatory line, since batch is reached *from inside*
     the editor (its own Apply to Batch button), not a standalone route — confirm this
     against `apps/web/src/app/editor/page.tsx`'s actual flow before finalizing card copy.
2. **`apps/web/src/app/layout.tsx`** (verify, edit if needed) — `[VERIFY during
   implementation]` whether a minimal persistent header (e.g. a small logo/home link so a
   user on `/editor` or `/quick-actions` can get back to `/`) is in scope for this task or a
   follow-up. Default to out-of-scope/minimal unless it's a small addition — this task is
   about the entry point, not a full nav redesign.
3. **`docs/90-deferred-register.md`** (edit) — mark `D-45` superseded, pointing at this task
   doc; its "no landing-page concept exists" reasoning no longer holds once this lands.
4. **`README.md`** (root, edit) — "Getting started" section currently says the frontend
   lands at `http://localhost:3001` with no mention of what's there. Update to describe the
   home page as the actual entry point (drop a file / pick a shortcut), not the editor
   directly.

## Porquê

The user explicitly asked to think through the full information architecture before
building anything else — not bolt a video upload page onto an unlinked redirect. The photo
editor has a from-scratch WebGPU live-preview experience; video/audio deliberately doesn't
(no such editor is in scope per the spec's Non-Goals). A single "drop anything" page with no
other signal would either imply video/audio gets the same live-preview treatment (it
doesn't) or bury it entirely (a first-time user would never find it). Drop-zone-plus-
shortcuts is the user's own chosen resolution: keep the direct, Apple-like "just drop a
file" feel as the default gesture, while still making the less-discoverable capability
(video/audio tools) an explicit, visible option rather than a hidden URL.

This also means the app finally *has* a home page, reversing `D-45`'s prior state — that
reversal needs to be recorded in the deferred register and README, not left as a silent
contradiction of a decision made earlier this same day.

## Ficheiros afectados

| File | Change type | Notes |
|---|---|---|
| `apps/web/src/app/page.tsx` | edit | replace `redirect()` with drop-zone + shortcut cards |
| `apps/web/src/app/layout.tsx` | edit (maybe) | minimal nav-back-home, if in scope |
| `docs/90-deferred-register.md` | edit | mark `D-45` superseded |
| `README.md` | edit | describe the real home page in Getting started |
