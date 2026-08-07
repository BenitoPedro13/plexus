# TASK-image-crop

## Cenário actual

`image.crop` does not exist anywhere in the codebase — not in the recipe schema
(`apps/web/src/lib/recipe/schema.ts`'s `imageProcessorId`/`recipeStepSchema`), not in the
Go processor registry (`workers/internal/processors/registry.go`), not in the live preview
(`apps/web/src/lib/preview/`), not in the editor UI (`apps/web/src/app/editor/page.tsx`).

The spec's P0 requirements list crop alongside light/color/filter as part of the
non-destructive recipe model (`docs/plexus-media-pipeline-spec.md` line 130: "crop, light,
color, filter adjustments stored as parameters"). The other three got a processor
(`image.adjustLight`/`adjustColor`/`blackAndWhite`) plus `image.sharpen` via
`TASK-composite-slider-mapping.md` and its follow-ups; crop was explicitly named as
out-of-scope there and tracked as a gap in `docs/90-deferred-register.md` `D-22`: "Crop:
needs its own `TASK-*` starting from a new `image.crop` processor (Go + schema), same shape
as `TASK-composite-slider-mapping.md`'s process."

Unlike Vibrance/Cast/Grain (`TASK-vibrance-cast-grain-spike.md`), crop needs no primitive
research spike: `workers/internal/govips-fork/vips/image_transform.go` already exports
`(*ImageRef).ExtractArea(left, top, width, height int) error` (confirmed by reading the
fork's own source directly, not assumed) — a plain rectangular crop, publicly available
without the `Tonelut`/`Gaussnoise`-style same-package fork extension `D-24`/`D-28` needed.
`image.resize` (`workers/internal/processors/resize.go`) is the closest existing pattern for
a geometry-changing (as opposed to composite-adjustment) processor.

This task scopes **schema + Go processor only** — the same first slice
`TASK-adjust-color-cast.md` and `TASK-black-and-white-grain.md` used for their params, each
followed by a separate preview-parity task (`TASK-color-cast-preview-parity.md`,
`TASK-grain-preview-parity.md`). Live-preview shader support and an editor UI control are
explicitly out of scope here and get their own follow-up task doc once this slice lands,
tracked as a new deferred-register entry below.

## Mudanças planeadas

**`apps/web/src/lib/recipe/schema.ts`** (edit)
- Add `'image.crop'` to `imageProcessorId`.
- Add `cropParamsSchema`: `x`, `y`, `width`, `height`, all `z.number()` normalized fractions
  of the source image's dimensions (`0.0..1.0`), not absolute pixels. Normalized because the
  same recipe step must apply identically at preview resolution (whatever the canvas is
  scaled to) and at full-resolution export (the actual source dimensions) — an absolute-pixel
  rect would only be correct for one of the two, breaking recipe/pipeline unification the
  moment preview and export run at different resolutions. `width`/`height` use `.gt(0)` (a
  zero-area crop is never valid); `x`/`y` use `.min(0).max(1)`. A `.refine` enforces
  `x + width <= 1.0` and `y + height <= 1.0` (with a small epsilon for float rounding), so an
  out-of-bounds rect is rejected at the schema layer, not just the Go layer.
- Add the `image.crop` variant to `recipeStepSchema`'s discriminated union, same shape as
  the existing seven.

**`workers/internal/processors/crop.go`** (new)
- `Crop(ctx, jobStepID, inputRef, params) (string, error)`, registered under `"image.crop"`.
- Reads `x`, `y`, `width`, `height` via the existing `requireFloatParamInRange(params, key,
  0.0, 1.0)` helper (`params.go`) — no new param-parsing helper needed.
- Validates `x+width <= 1.0+epsilon` and `y+height <= 1.0+epsilon` (mirrors the schema's
  `.refine`, since the Go side has no dependency on the TS schema and must validate
  independently — same pattern every other processor already follows).
- Loads the image, reads its actual `Width()`/`Height()`, converts the normalized rect to
  pixels (`math.Round(x * float64(srcW))`, etc.), then clamps the computed `width`/`height`
  so rounding can never push `left+width` or `top+height` past the source bounds (govips'
  `ExtractArea` errors on an out-of-bounds rect — this task fixes rounding drift before it
  gets there rather than letting a legitimate `x=0.999, width=0.002` request fail).
  Clamped width/height floor at `1` pixel.
- Calls `img.ExtractArea(left, top, width, height)`, then exports via the existing
  `exportFormat`/`originalFormatName`/`writeOutput` helpers — output keeps the input's
  original format, matching every other geometry/composite processor's convention (crop
  never changes format, same note `resize.go`'s doc comment already makes for resize).

**`workers/internal/processors/crop_test.go`** (new)
- Mirrors `resize_test.go`'s structure against the same `gradient.jpg`/`gradient.png` 64×48
  fixtures: crops to a known sub-rect and asserts exact output pixel dimensions; a
  full-frame crop (`x=y=0, width=height=1`) is a no-op-sized output; edge-of-bounds crop
  (`x=0.5, width=0.5` on odd-dimensioned math) doesn't error from rounding; `x+width > 1.0`
  is a validation error; missing/negative params are validation errors; output path naming
  under `WORKER_STORAGE_DIR` matches the `resize_test.go` convention; nonexistent input file
  errors rather than panics.

**`workers/internal/processors/registry.go`** (edit)
- Add `"image.crop": Crop` to `registry`; update the package doc comment's processor list
  (already slightly stale — doesn't mention `TASK-adjust-color-cast.md`/
  `TASK-black-and-white-grain.md`'s params — this task fixes the doc comment while touching
  the file, not a scope-creep addition).

**`docs/90-deferred-register.md`** (edit)
- Resolve the crop portion of `D-22` referencing this task.
- Add a new `D-xx` for the deferred live-preview-shader + editor-UI slice, same shape as
  `D-25`/`D-30`/`D-31` before their respective parity tasks landed.

**`docs/plexus-media-pipeline-spec.md`** (edit)
- Update the Open Questions crop/composite-slider paragraph (currently silent on crop) to
  note the Go-side implementation landed and preview/UI parity is still pending.

## Porquê

Crop is explicitly P0 in the spec, grouped with the three params (light/color/filter) that
already shipped — leaving it unimplemented is a real gap in "editor MVP," not a nice-to-have.
`D-22` already named this as the concrete next step once the composite-slider work's own
open questions (blend-ratio visual tuning) hit a wall that needs the user's own eyes on a
real photo — crop has no such blocker: a rectangular extract has one unambiguous, correct
behavior (no aesthetic judgment call, unlike Vibrance's curve or the Light master slider's
blend ratios), so it can proceed without that review loop.

Scoping this to schema + Go processor only (deferring preview/UI) follows the same two-slice
split the last three params used, for the same reason: it lets the backend contract (param
shape, validation, Go behavior) land and get exercised by tests before committing to a
shader-side geometry approach, which is a separable design question (does crop become part
of the same final-blit UV-rect math `D-21` already uses for resize, or a true resampling
pass? — worth its own task doc once this slice's param shape is settled, not decided
speculatively here).

Normalized (0..1) coordinates rather than absolute pixels is the one real design decision in
this slice: it's what makes the *same* crop recipe step correct at both live-preview
resolution and full-resolution export, which is the specific property `docs/90-deferred-register.md`'s
recipe-fidelity concern (and the spec's "Reuse proof" success metric) depends on — an
absolute-pixel rect chosen against a preview-sized canvas would be silently wrong at export
resolution, exactly the "export doesn't match preview" failure mode CLAUDE.md §3.3 calls out.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/recipe/schema.ts` | edit | add `cropParamsSchema`, `'image.crop'` to `imageProcessorId` and `recipeStepSchema` |
| `workers/internal/processors/crop.go` | new | `Crop` processor via `ExtractArea`, normalized-to-pixel conversion + clamping |
| `workers/internal/processors/crop_test.go` | new | table tests mirroring `resize_test.go` |
| `workers/internal/processors/registry.go` | edit | register `"image.crop"`, refresh stale doc comment |
| `docs/90-deferred-register.md` | edit | resolve crop portion of `D-22`, add new `D-xx` for deferred preview/UI slice |
| `docs/plexus-media-pipeline-spec.md` | edit | update Open Questions crop/composite-slider paragraph |
