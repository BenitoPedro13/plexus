# TASK: Video/audio quick-actions screen

## Cenário actual

`apps/web` has exactly two real routes today: `/editor` (the WebGPU/WebGL2 photo editor,
`apps/web/src/app/editor/page.tsx`) and `/batch/[pipelineId]` (poll/download view for a
batch job created by the editor's Apply to Batch button). The root route (`/`) is a bare
`redirect("/editor")` (`apps/web/src/app/page.tsx`, closed same-day by `D-45`) — the editor
is currently framed as the app's only surface.

The editor's file input is `accept="image/*"` (`apps/web/src/app/editor/page.tsx:237,273`)
— there is no path anywhere in `apps/web` that accepts a video or audio file.

Meanwhile, four video/audio processors are implemented and tested Go-side
(`workers/internal/processors/video_compress.go`, `video_transcode.go`, `audio_extract.go`,
`audio_convert.go`) and already accepted by the orchestrator's pipeline validation
(`apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts`'s `BUILTIN_PROCESSORS`
includes `video.transcode`, `video.compress`, `audio.extract`, `audio.convert`). But
`packages/recipe/src/schema.ts`'s `imageProcessorId`/`recipeStepSchema` — the one canonical
TS recipe schema both `apps/web` and `apps/orchestrator` import — deliberately excludes
them (`schema.ts:2-5`: *"video/audio processors don't apply to the single-image editor"*).
Net effect: these four processors are only reachable today via a raw API call
(`curl`/Postman against `POST /pipelines` + `POST /jobs`), not through the app itself. This
is the gap identified in conversation with the user this session.

Two real backend gaps also matter for what this screen can honestly promise:

- `video.compress` reads the input's container from its file extension and requires it to
  already be `mp4` or `webm` (`video_compress.go`'s `videoCodecsForContainer` check) — it
  errors on `.mov`/`.avi`/`.mkv` input rather than transcoding first.
- `video.compress`'s `quality` param (1-100, higher = better quality/bigger file — see
  `ffmpeg.go`'s `videoCrfArgs`, a CRF-style knob) has no relationship to a target output
  size in MB. There is no 2-pass/target-bitrate encoding path today.

## Mudanças planeadas

1. **`packages/recipe/src/schema.ts`** (edit) — add `videoProcessorId`/`audioProcessorId`
   enums and per-processor param schemas (`videoTranscodeParamsSchema`,
   `videoCompressParamsSchema`, `audioExtractParamsSchema`, `audioConvertParamsSchema`),
   each mirroring its Go processor's doc comment exactly — same convention the 8 existing
   image schemas already follow (e.g. `format` as a `z.enum` matching the Go switch's exact
   string set, `bitrate` optional 32-320 default 128, `quality` optional 1-100 default 75).
   Extend `recipeStepSchema`'s discriminated union with 4 new literal branches. Purely
   additive — no existing branch changes, so the editor and its ~160 existing tests are
   unaffected.
2. **`apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts`** (verify, edit if
   needed) — `[VERIFY during implementation]`: confirm whether this DTO's per-processor
   param validation already imports from `@plexus/recipe` for these 4 ids or still
   hand-validates them separately (the file's own comment at the top of `BUILTIN_PROCESSORS`
   suggests the latter). If separate, point it at the new schemas from item 1 instead of a
   second hand-maintained copy — this is exactly the drift `D-1`/`D-17` already closed for
   images.
3. **`apps/web/src/app/quick-actions/page.tsx`** (new) — the screen itself. Accepts one
   video or audio file (`accept="video/*,audio/*"`), detects kind from `file.type` and
   container from the filename extension, and shows a small fixed set of **named preset
   buttons only** — no raw parameter sliders, no "Adjust manually," per the user's explicit
   "presets only for v1" decision:

   | Preset | Input container | Recipe steps |
   |---|---|---|
   | Shrink for sharing | `.mp4`/`.webm` | `video.compress` `{ quality: 30 }` |
   | Shrink for sharing | anything else (`.mov`, `.avi`, `.mkv`, …) | `video.transcode` `{ format: 'mp4', quality: 75 }` → `video.compress` `{ quality: 30 }` (2-step recipe, since `video.compress` can't take a non-mp4/webm input directly) |
   | Convert to MP4 | any | `video.transcode` `{ format: 'mp4' }` |
   | Convert to WebM | any | `video.transcode` `{ format: 'webm' }` |
   | Extract audio as MP3 | video input | `audio.extract` `{ format: 'mp3', bitrate: 128 }` |
   | Convert to MP3 | audio input | `audio.convert` `{ format: 'mp3', bitrate: 128 }` |
   | Convert to WAV | audio input | `audio.convert` `{ format: 'wav' }` |

   "Shrink for sharing" copy explicitly avoids promising a target size (e.g. "smaller file,
   some quality loss" rather than "under 20MB") — see Porquê.

   Must load the `frontend-design:frontend-design` skill and build with shadcn components
   per `CLAUDE.md` §2.0, reusing the existing dropzone visual pattern from
   `apps/web/src/app/editor/page.tsx` rather than inventing new markup/CSS.

   On preset click: `uploadFile()` (`apps/web/src/lib/editor/batch.ts`, reused unmodified)
   → `createPipelineFromRecipe()` (same file, reused unmodified) → new `createJob()` (item
   4) → `router.push` to the progress route (item 5).
4. **`apps/web/src/lib/editor/batch.ts`** (edit) — add `createJob(pipelineId, inputRef)`
   calling the orchestrator's `POST /jobs` (singular — documented in
   `apps/orchestrator/README.md`, not yet called from anywhere in `apps/web`, which today
   only calls `POST /jobs/batch`). Mirrors `createBatchJobs`'s existing shape and error
   handling exactly.
5. **`apps/web/src/app/quick-actions/[jobId]/page.tsx`** (new) — progress + download
   screen. Reuses `useJobProgress(jobId)` (`apps/web/src/lib/jobs/useJobProgress.ts`,
   unmodified) exactly as `apps/web/src/app/batch/[pipelineId]/page.tsx` already does, plus
   a download link via `GET /uploads/presign-download` once the job's single step succeeds.
6. **`apps/web/src/lib/quick-actions/presets.ts`** (new) — pure functions mapping
   `(fileKind, containerExt) → { label, steps: Recipe['steps'] }[]`, unit-tested in
   isolation. Same extraction precedent already used for `light-blend.ts`/`crop-drag.ts` —
   keeps the preset table testable without a browser/DOM.
7. **`docs/90-deferred-register.md`** (edit) — new `D-xx` entry: `video.compress` has no
   target-file-size mode, only a CRF-style quality knob; the "Shrink for sharing" preset's
   copy is written to not imply a size guarantee. Re-evaluation trigger: if a future task
   wants a literal "under N MB" promise, it needs 2-pass/target-bitrate ffmpeg args, not
   attempted here.

## Porquê

Closes the exact gap surfaced this session: video/audio processing is real, tested, and
working Go-side, but has no clickable path in the app — today "testing" it means `go test`
or raw `curl`. This is the missing piece needed before a non-technical friend could ever
touch that half of the product.

The **presets-only** shape is a direct, explicit user decision (not a default), and it also
matches the spec's own P0 editor principle #4 ("presets as the primary entry point, manual
editing as the escape hatch") — applied here to video/audio even though those processors
don't have a live-preview editor of their own, per the spec's Non-Goals (no
timeline/professional editor for video/audio).

Reusing `uploadFile`/`createPipelineFromRecipe`/`useJobProgress` unmodified, and extending
`packages/recipe` rather than hand-typing video/audio steps only inside `apps/web`, keeps
the "one canonical recipe schema, both sides import it" contract intact (`CLAUDE.md` §4) —
presets are just recipes, dispatched through the exact same pipeline/job machinery the
editor's Apply to Batch flow already proved out. No new backend concept, no parallel system.

The two-step "Shrink for sharing" recipe for non-mp4/webm input is a deliberate UX
correction: silently erroring on a `.mov` upload (`video.compress`'s real, current
constraint) would be a broken first impression for exactly the audience this task is for.
Chaining `video.transcode` → `video.compress` costs nothing architecturally — it's the same
DAG mechanism already proven for image recipes, just two steps instead of one.

## Ficheiros afectados

| File | Change type | Notes |
|---|---|---|
| `packages/recipe/src/schema.ts` | edit | add video/audio processor id enums + param schemas + 4 new discriminated-union branches |
| `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts` | edit (maybe) | point at `@plexus/recipe` for video/audio param validation if not already |
| `apps/web/src/app/quick-actions/page.tsx` | new | upload + preset-selection screen |
| `apps/web/src/app/quick-actions/[jobId]/page.tsx` | new | progress + download screen |
| `apps/web/src/lib/editor/batch.ts` | edit | add `createJob()` (single-job `POST /jobs`) |
| `apps/web/src/lib/quick-actions/presets.ts` | new | pure preset-table functions, unit-tested |
| `docs/90-deferred-register.md` | edit | new `D-xx`: no target-file-size compress mode |
