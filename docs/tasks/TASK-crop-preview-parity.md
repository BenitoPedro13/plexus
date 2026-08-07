# TASK-crop-preview-parity

## Cenário actual

`image.crop` exists Go-side and in the schema (`TASK-image-crop.md`, `workers/internal/processors/crop.go`,
`apps/web/src/lib/recipe/schema.ts`'s `cropParamsSchema`) — a normalized (0..1) rectangular
extract via govips' `ExtractArea`. It has **no live-preview shader pass and no editor UI
control**, tracked as open debt in `docs/90-deferred-register.md` `D-33`.

The live preview (`apps/web/src/lib/preview/webgpu-renderer.ts`,
`webgl2-renderer.ts`) already has a precedent for one geometry-changing processor,
`image.resize`: both renderers' `render()` methods call `findLastResizeStep(recipe)` +
`computeFitGeometry(sourceDimensions, params)` (`geometry.ts`) to get a single UV sub-rect
applied only at the *final* blit into the canvas — content-adjustment steps
(`adjustLight`/`adjustColor`/`blackAndWhite`/`sharpen`) always run first, at full source
resolution, regardless of where `image.resize` actually sits in `recipe.steps` (`D-21`:
resize's *position relative to content steps* is deliberately not modeled).

Crop is a second geometry-changing processor with the same "final UV rect" shape resize
already has — `D-33` explicitly asks this task to decide whether crop folds into that same
final-blit math or needs a true resampling pass, informed by `D-21`'s existing resize
precedent. Unlike content steps' commutativity, crop and resize **do not commute** with
each other: `Crop`'s `x`/`y`/`width`/`height` in `crop.go` are normalized fractions of
*whatever image is input to that step* — so `crop → resize` (crop the original, then
fit-resize the cropped result) and `resize → crop` (resize first, then crop a fraction of
the *resized* result) are genuinely different outputs. `findLastResizeStep`'s
"last-one-wins, ignore where it sits" approach cannot be naively extended to crop; the two
steps' relative order in `recipe.steps` has to be respected.

The editor UI (`apps/web/src/app/editor/page.tsx`) has controls for every other P0 param
(`LightControl`, `ColorControl`, `BlackAndWhiteControl`, `SharpenControl`, plus a raw
width/height/fit resize `fieldset`) but nothing for crop. Every existing control is a
slider/checkbox against a fixed numeric range; crop is a spatial selection and needs a
genuinely different interaction (`D-33`: "likely a drag rect over the canvas, not a
slider").

## Mudanças planeadas

**`apps/web/src/lib/preview/geometry.ts`** (edit)
- Add `findLastCropStep(recipe)`, mirroring `findLastResizeStep` exactly (`Extract<RecipeStep,
  { processor: 'image.crop' }>`, last-one-wins if more than one appears).
- Add `computeGeometryChain(source: ImageDimensions, recipe: Recipe): FitGeometry`. Walks
  `recipe.steps` **in order**, tracking a running `currentDims: ImageDimensions` (starts at
  `source`) and a running `currentUV: UVRect` (starts at the full unit square, expressed in
  *original source* UV space):
  - On an `image.crop` step: mirrors `crop.go`'s own pixel rounding —
    `cropPxW = Math.round(params.width * currentDims.width)` (same for height/x/y) against
    the *current* dims, not the original source — then remaps that pixel rect into a
    fraction of `currentUV` (`newU0 = currentUV.u0 + (x*currentDims.width)/currentDims.width
    * (currentUV.u1-currentUV.u0)`, i.e. plain fraction composition since crop's fractions
    are already relative to `currentDims`) and updates `currentDims` to the cropped pixel
    size.
  - On an `image.resize` step: calls the existing `computeFitGeometry(currentDims, params)`
    (unchanged), then remaps its returned `sourceUV` (relative to `currentDims`) through
    `currentUV` the same way, and updates `currentDims` to the resize's output dimensions.
  - Any other step id is skipped (content-adjustment steps don't affect geometry, unchanged
    from today).
  - Returns `{ outputWidth: currentDims.width, outputHeight: currentDims.height, sourceUV:
    currentUV }` after the walk. With no crop/resize steps at all, returns the same
    full-source fallback both renderers already construct inline today.
  - `computeFitGeometry`/`findLastResizeStep` stay exported and unchanged — `
    computeGeometryChain` calls the former internally; both are still directly unit-tested.

**`apps/web/src/lib/preview/geometry.test.ts`** (edit)
- New `describe('computeGeometryChain')` block: crop-only (asserts the exact UV sub-rect and
  output dims for a known rect); resize-only (must equal today's direct
  `computeFitGeometry` call — regression guard); crop-then-resize vs. resize-then-crop with
  the *same* params on both steps, asserting the two composed results are genuinely
  different (proves order is respected, not just "last wins"); a crop rounding case at an
  odd source dimension, checked against the same `Math.round` arithmetic `crop.go` uses, so
  the preview and the Go export agree on pixel boundaries; no-crop-no-resize fallback case.

**`apps/web/src/lib/preview/webgpu-renderer.ts`** (edit)
- `render()`: replace the current `findLastResizeStep(recipe)` /
  `computeFitGeometry(...)` / inline-fallback block (lines ~715–722) with one
  `computeGeometryChain(this.sourceDimensions, recipe)` call. No shader, pipeline, or
  bind-group changes — crop reuses the exact same `blitUniformBuffer`/`BLIT_SHADER_SOURCE`
  UV-rect mechanism resize already drives; only the JS-side geometry math changes.
- Update the `CONTENT_VERTEX_BLOCK` doc comment (currently only mentions resize/D-21) to
  note crop shares the same simplification.

**`apps/web/src/lib/preview/webgl2-renderer.ts`** (edit)
- Same replacement in its `render()` (the equivalent `findLastResizeStep`/
  `computeFitGeometry` block, confirmed at the same call shape as the WebGPU renderer).

**`apps/web/src/lib/editor/crop-drag.ts`** (new)
- Pure function `dragRectToCropParams(drag: { x0: number; y0: number; x1: number; y1: number
  }, canvasSize: { width: number; height: number }): CropParams | null` — converts a
  pointer-drag rectangle in canvas CSS-pixel space into normalized `cropParamsSchema` fields
  (`x`, `y`, `width`, `height`), independent of any React/DOM/canvas-rendering concerns so
  it's directly unit-testable (same reason `light-blend.ts` was extracted from its control
  component). Normalizes an any-direction drag (`x1 < x0` allowed), clamps to `[0,
  canvasSize.width]`/`[0, canvasSize.height]`, and returns `null` (not an error) for a
  degenerate drag below a small pixel-size floor (a click/tiny drag means "no crop change,"
  not "crop to a 1px sliver").
- `apps/web/src/lib/editor/crop-drag.test.ts` (new): straightforward rect, reversed-direction
  drag, out-of-canvas-bounds drag (clamped), below-floor drag (returns `null`), exact-edge
  drag (full canvas → `{x:0,y:0,width:1,height:1}`).

**`apps/web/src/components/editor/CropControl.tsx`** (new)
- Self-contained crop tool, decoupled from the WebGPU/WebGL live-preview canvas entirely —
  it draws the raw source `ImageBitmap` into its own small 2D `<canvas>` (`drawImage`, scaled
  to fit a fixed max display width, no crop/resize/adjustments applied), with a
  pointer-drag rectangle drawn on top (native 2D canvas strokes, redrawn on
  `pointermove`). Deliberately not layered on top of `PreviewCanvas`'s WebGPU/WebGL canvas:
  that canvas already reflects the *composed* crop+resize geometry (`computeGeometryChain`),
  so a rect dragged over it would live in a coordinate frame that shifts depending on the
  current `fit` mode and any previously-committed crop — the same coordinate-frame problem
  this task's `Porquê` section explains below. Drawing straight from the untouched
  `ImageBitmap` sidesteps that: the drag is always in original-source-fraction space, which
  is exactly what `crop.go` (and the new crop-first recipe order below) expects.
- Props: `image: ImageBitmap | null`, `value: CropParams | null`, `enabled: boolean`,
  `onEnabledChange: (enabled: boolean) => void`, `onChange: (next: CropParams) => void`,
  `onCommit: () => void` — same enabled/value/onChange/onCommit shape as
  `BlackAndWhiteControl`. Renders a disabled hint (no canvas) when `image` is `null`.
- On `pointerup`, calls `dragRectToCropParams` (skips `onChange`/`onCommit` if it returns
  `null`) then `onCommit()`, matching every other control's history-commit convention.
- Explicitly out of scope, tracked as a new deferred-register entry: resizable/draggable
  handles on an already-drawn rect (each drag redefines the rect from scratch), aspect-ratio
  lock/presets, rotation.

**`apps/web/src/app/editor/page.tsx`** (edit)
- `EditState` gains `crop: CropParams | null` (`null` = no crop, the identity case); import
  `CropParams` from `@/lib/recipe/schema`; `initialEditState.crop = null`.
- `deriveRecipe`: when `state.crop` is non-null, push an `image.crop` step **before** the
  existing unconditional `image.resize` step — crop-first order, matching "select a region
  of the original, then thumbnail-fit that region," which is also the concrete case that
  makes `computeGeometryChain`'s order-sensitivity (as opposed to resize's
  order-insensitive `findLastResizeStep`) load-bearing rather than theoretical.
- Render `<CropControl image={image} value={live.crop} enabled={live.crop !== null}
  onEnabledChange={...} onChange={(crop) => history.setPresent({ ...live, crop })}
  onCommit={history.commit} />` in the `aside`, alongside the other controls.

**`docs/90-deferred-register.md`** (edit)
- Resolve `D-33`, referencing this task and summarizing the crop-vs-resize order finding.
- Add a new `D-xx` for `CropControl`'s deferred interaction refinements (resize handles,
  aspect lock, rotation).
- Add a new `D-xx` noting crop introduces **no new preview/export pixel drift** to measure
  via `drift.test.ts`'s golden-fixture methodology (`V-2`/`D-23`'s existing approach): crop
  is an exact UV sub-rect selection with no resampling of its own (`ExtractArea` is a pixel-
  exact copy; the preview's fractional-UV crop selects the identical region, just deferred to
  the existing final-blit bilinear sample already covered by resize's own measured drift,
  `D-23`). `computeGeometryChain`'s correctness is instead covered by `geometry.test.ts`'s
  exact-arithmetic unit tests, since there's no encoder/interpolation nondeterminism to
  average over the way pixel-value drift tests handle.

**`docs/plexus-media-pipeline-spec.md`** (edit)
- Update the Open Questions crop paragraph (touched by `TASK-image-crop.md`) to note preview
  and editor UI parity have now also landed, closing the last piece of spec P0 crop bullet.

## Porquê

Crop is spec P0, grouped with light/color/filter (`docs/plexus-media-pipeline-spec.md` line
130) — `TASK-image-crop.md` deliberately split out preview/UI as a follow-up (`D-33`) once
the backend param shape was settled and exercised by tests, the same two-slice pattern
`D-25`/`D-30`/`D-31` used for highlights/shadows, cast, and grain. This task closes that
follow-up, and is the last piece needed for "editor MVP" to actually cover every P0 bullet.

The one real design question `D-33` left open — UV-rect-vs-resampling-pass, "informed by
`D-21`'s existing resize precedent" — resolves in favor of extending the UV-rect approach,
not adding a true resampling pass: crop, like resize, is a rectangular operation expressible
entirely as "which sub-rect of the source texture does the final blit sample from," so no
new GPU texture pass is needed, keeping the renderers' pipeline count unchanged. The part
that's genuinely new (not just "copy resize's pattern") is that crop and resize don't
commute with each other the way content-adjustment steps commute with geometry steps —
`findLastResizeStep`'s "ignore recipe position, last one wins" shortcut only works today
because there is exactly one geometry-affecting processor. With two, `crop → resize` and
`resize → crop` are different outputs (verified by reading `crop.go`: its params are
fractions of *whatever image is currently being processed*, not the original source), so
`computeGeometryChain` has to actually walk the recipe in order and compose transforms —
this is the concrete case that turns `D-21`'s "position doesn't matter" simplification into
something that provably does matter for at least one pair of steps, which is worth being
explicit about since a future third geometry processor would need the same composition, not
another special case.

`CropControl` drawing from the raw `ImageBitmap` in its own canvas, rather than overlaying
the live WebGPU/WebGL preview canvas, is a scope call driven by a real coordinate-frame
problem: the live preview canvas always shows the *fully composed* geometry (existing crop +
resize's `fit` mode, which for `fit: 'cover'` already crops around the center). A drag
rectangle over that canvas would need to be un-composed back through whatever crop/resize
state is already live before it could be turned into a fresh original-source-relative crop
rect — solvable, but meaningfully more machinery than a second small canvas that simply
always shows the untouched source. Given the editor's crop tool only ever needs to define
one rect at a time (not stack crops), the simpler decoupled approach is both correct and
non-destructive (the user can always redraw a wider rect against the true original, never
compounding a previous crop's boundary) — matching CLAUDE.md's non-destructive-editing
invariant more directly than an overlay-on-composed-canvas approach would.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/geometry.ts` | edit | add `findLastCropStep`, `computeGeometryChain` (order-aware crop+resize composition) |
| `apps/web/src/lib/preview/geometry.test.ts` | edit | tests for `computeGeometryChain`, incl. order-sensitivity |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | `render()` uses `computeGeometryChain` instead of resize-only logic |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | same replacement |
| `apps/web/src/lib/editor/crop-drag.ts` | new | pure drag-rect → normalized `CropParams` conversion |
| `apps/web/src/lib/editor/crop-drag.test.ts` | new | unit tests for the conversion, incl. clamping/degenerate-drag cases |
| `apps/web/src/components/editor/CropControl.tsx` | new | decoupled 2D-canvas crop-selection tool |
| `apps/web/src/app/editor/page.tsx` | edit | `EditState.crop`, crop-first `deriveRecipe` order, render `CropControl` |
| `docs/90-deferred-register.md` | edit | resolve `D-33`; add new `D-xx` for UI refinements + no-new-drift-fixture note |
| `docs/plexus-media-pipeline-spec.md` | edit | close crop's Open Questions paragraph |
