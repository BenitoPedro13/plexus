# TASK-preview-renderer — WebGPU/WebGL2 dual-path live preview (Phase 2)

## Cenário actual

`apps/web` has a Next.js 16.3 shell (`TASK-editor-scaffold.md`) and a typed Edit Recipe
data model (`apps/web/src/lib/recipe/schema.ts`, `TASK-recipe-schema.md`): `Recipe { name?,
steps: RecipeStep[] }`, where each `RecipeStep` is one of `image.resize` (`width`, `height`,
`fit: "inside" | "cover"`), `image.convert` (`format`, `quality`), or `image.compress`
(`quality`). Nothing consumes this type yet — there is no rendering code anywhere in
`apps/web`, no canvas, no shader.

Two decisions already made upstream constrain this task:

- **V-1 (resolved, `TASK-editor-scaffold.md`)**: WebGPU is solid on Chrome/Edge and current
  Safari, but Firefox lacks default support on most platforms today. Decision: the
  Canvas2D/WebGL2 fallback is a **first-class, parallel implementation**, not a stubbed
  "unsupported browser" message.
- **D-6 (open, `docs/90-deferred-register.md`)**: the curated composite sliders (Light,
  Color, B&W, Sharpen) have no parameter mapping yet — they need new processor
  ids/params that don't exist in the Go workers. Out of scope here.

That second point matters more than it looks: the only processors this task can preview are
the three that exist today — `image.resize`, `image.convert`, `image.compress`. None of
them is a "slider you drag and see a color shift" — `image.resize` is a geometric transform
(genuinely previewable), while `image.convert`/`image.compress` only affect *lossy encoding
artifacts and container format*, not per-pixel appearance in a way a real-time shader can
reproduce without literally re-running a JPEG/WebP/AVIF encoder every frame. This task
confronts that directly rather than building a shader that pretends to simulate compression
artifacts — see "Convert/compress: no artifact simulation" below.

## Mudanças planeadas

Scope: the rendering engine (backend selection, WebGPU implementation, WebGL2
implementation, shared geometry math) plus a minimal, unstyled demo route that proves the
dual-path routing and the resize preview work end to end. Explicitly **not** in scope:
composite sliders (`D-6`), the real editor UI/layout, undo/redo, upload flow, numeric
preview/export fidelity bounds beyond what's noted below (`V-2`).

Verified this session (2026-08-07), per CLAUDE.md §2.0, rather than assumed from training
data:

- MDN's WebGPU API reference: `navigator.gpu` → `GPU.requestAdapter()` →
  `GPUAdapter.requestDevice()` → `canvas.getContext("webgpu")` →
  `GPUCanvasContext.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(),
  alphaMode })`; shaders are WGSL, packaged via `device.createShaderModule()`. Still
  "Limited availability" per MDN's Baseline classification (page updated 2026-05-05) — no
  breaking API changes since V-1's research. Secure-context (HTTPS) only.
- MDN's `WebGL2RenderingContext` reference: Baseline **Widely available** since September
  2021; `canvas.getContext("webgl2")` unchanged. No fallback-within-fallback needed — WebGL2
  itself is the safe floor.
- `apps/web`'s installed TypeScript (5.9.3) does **not** bundle WebGPU ambient types
  (`grep -rl "interface GPUDevice" node_modules/typescript/lib/*.d.ts` — no match). The
  `@webgpu/types` package (npm, latest `0.1.71`, published 2026-06-24) supplies them.

### 1. `apps/web/src/lib/preview/geometry.ts` (new)

Pure functions, no DOM/GPU dependency — the only part of this task that's meaningfully unit
testable without a real browser:

- `computeFitGeometry(source: { width: number; height: number }, params: ResizeParams):
  { outputWidth: number; outputHeight: number; sourceUV: { u0: number; v0: number; u1:
  number; v1: number } }`.
- `fit: "inside"` (mirrors `workers/internal/processors/resize.go`'s `vips.InterestingNone`
  path): `scale = min(targetW/srcW, targetH/srcH)`, output is `srcW*scale x srcH*scale`
  (no crop, full source visible, `sourceUV` is the full `[0,1]x[0,1]` unit square) — matches
  `Thumbnail(w, h, InterestingNone)`'s "fit within box, no crop" behavior.
- `fit: "cover"` (mirrors `vips.InterestingCentre`): `scale = max(targetW/srcW,
  targetH/srcH)`, output is exactly `targetW x targetH`, `sourceUV` is a centered crop
  window sized `(targetW/scale)/srcW` × `(targetH/scale)/srcH` in normalized source
  coordinates — matches `Thumbnail(w, h, InterestingCentre)`'s "crop to exactly fill"
  behavior.
- This function is the single source of truth both renderer backends call — geometry math
  is written once, not duplicated per backend (WGSL and GLSL just consume the same numbers
  as uniforms).

### 2. `apps/web/src/lib/preview/geometry.test.ts` (new)

Vitest, plain arithmetic, no jsdom/GPU needed: known source/target/fit combinations (e.g.
800×600 source into a 400×400 box) checked against hand-computed expected `outputWidth`/
`outputHeight`/`sourceUV` for both `inside` and `cover`. Edge cases: source and target
already same aspect ratio (UV should be the full unit square even under `cover`); degenerate
1×1 target.

### 3. `apps/web/src/lib/preview/types.ts` (new)

Shared contract both backends implement, so the demo route and any future editor UI depend
on one interface, not two:

```ts
export type PreviewBackendKind = "webgpu" | "webgl2";

export interface PreviewRenderer {
  readonly kind: PreviewBackendKind;
  init(canvas: HTMLCanvasElement, source: ImageBitmap): Promise<void>;
  render(recipe: Recipe): void; // render-on-demand, not a rAF loop — see Porquê
  dispose(): void; // releases the GPU device/context; required before unmount
}
```

### 4. `apps/web/src/lib/preview/capabilities.ts` (new)

`detectPreviewBackend(): Promise<PreviewBackendKind | "unsupported">`. Per V-1's decision,
detection is **runtime feature probing, not user-agent/version sniffing**:

1. If `"gpu" in navigator`, actually attempt `await navigator.gpu.requestAdapter()` inside a
   try/catch — `navigator.gpu` can exist while adapter request still fails (blocklisted
   GPU, software-only platform), so presence of the property alone is not sufficient
   evidence.
2. On any failure (property absent, `requestAdapter()` throws or resolves `null`), probe
   `document.createElement("canvas").getContext("webgl2")`.
3. If that also fails, return `"unsupported"` — the demo route surfaces this as a plain
   message, not a crash. (A third Canvas2D-only tier was considered and rejected here: it
   can only ever represent `image.resize` via `drawImage`, not the eventual composite
   sliders, so it would be a dead end requiring a rewrite once `D-6` lands. `"unsupported"`
   is honest about that instead of building a throwaway tier.)

Because this is capability probing rather than version sniffing, it does not depend on
resolving the caniuse-vs-gpuweb-wiki Safari version discrepancy — see `V-5` below.

### 5. `apps/web/src/lib/preview/webgpu-renderer.ts` (new)

`WebGPURenderer implements PreviewRenderer`. `init()`: request adapter/device (already
proven available by `capabilities.ts` before this is constructed, but request again here —
`capabilities.ts`'s probe result isn't threaded through, and a second cheap
`requestAdapter()` call keeps this class self-contained), configure the canvas context with
`navigator.gpu.getPreferredCanvasFormat()`, upload `source` as a `GPUTexture` via
`device.queue.copyExternalImageToTexture()`, create a render pipeline for a single textured
quad. `render(recipe)`: walk `recipe.steps`, apply `computeFitGeometry()` for any
`image.resize` step to size the canvas and set the quad's UV uniform (the last resize step
wins if a recipe somehow has more than one — Phase 2 recipes only ever have zero or one in
practice); `image.convert`/`image.compress` steps are no-ops in this render (see "Convert/
compress" below). One WGSL shader module: vertex stage emits the full-canvas quad,
fragment stage samples the source texture through the UV rect from `computeFitGeometry()`.
`dispose()`: `device.destroy()`.

`/// <reference types="@webgpu/types" />` at the top of this file only — deliberately not
added to `tsconfig.json`'s (currently absent) `types` array, which would apply repo-wide and
risk suppressing auto-inclusion of any other ambient `@types/*` package added later.

### 6. `apps/web/src/lib/preview/webgl2-renderer.ts` (new)

`WebGL2Renderer implements PreviewRenderer`. Same shape as the WebGPU renderer, GLSL ES 3.00
instead of WGSL: `gl.createTexture()` + `gl.texImage2D()` for the source image, a
vertex/fragment shader pair compiled via `gl.createShader()`/`gl.compileShader()`, same
UV-rect uniform fed by `computeFitGeometry()`. `dispose()`: delete the GL objects it created
(texture, buffers, program) — a plain WebGL2 context is not auto-released.

### 7. `apps/web/src/components/PreviewCanvas.tsx` (new)

Client component (`"use client"`). Props: `{ image: ImageBitmap | null; recipe: Recipe }`.
On mount / when `image` changes: calls `detectPreviewBackend()`, instantiates
`WebGPURenderer` or `WebGL2Renderer` accordingly (or renders an "unsupported" message),
calls `init()`. On `recipe` change: calls `render(recipe)` — no continuous animation loop;
this is a static-image editor, not video, so rendering only on actual input change is
correct and cheaper, not a shortcut (see Porquê). On unmount: calls `dispose()`. Also
renders the selected backend's `kind` in a small text label — visible proof, in the demo
route and later in real QA, of which path actually ran.

### 8. `apps/web/src/app/preview-demo/page.tsx` (new)

Minimal, deliberately unstyled demo route — not the real editor UI, which still needs `D-6`
resolved first. An `<input type="file" accept="image/*">` to load a local image via
`createImageBitmap()` (no bundled fixture image and no hotlinked external URL — the former
adds a licensing/binary-asset question this task doesn't need to answer, the latter isn't
something CLAUDE.md permits inventing), plus plain number inputs for `width`/`height` and a
`select` for `fit`, wired into a single-step `Recipe` passed to `PreviewCanvas`. Proves: the
dual-path selection actually runs in a real browser, and dragging the width/height/fit
inputs updates the live preview.

### 9. `apps/web/package.json` (edit)

Add `@webgpu/types` (`^0.1.71` — re-check per CLAUDE.md §2.0 before installing if this task
is picked back up later) as a devDependency. No new runtime dependency: both backends use
native browser APIs only, nothing to add for WebGL2.

### 10. `docs/plexus-media-pipeline-spec.md` (edit)

Architecture table's "Editor live preview" row and the "Editor: live client-side preview"
bullet get a short cross-reference to `apps/web/src/lib/preview/` as the concrete
implementation, same pattern `TASK-recipe-schema.md` used for the recipe type.

### 11. `docs/90-deferred-register.md` (edit)

- New **V-6**: `image.resize` preview uses the GPU's native texture-sampling filter
  (hardware bilinear, both WGSL and GLSL default `sampler`/`texture()` behavior) while
  `workers/internal/processors/resize.go`'s `img.Thumbnail()` uses libvips' own resize
  kernel — `[VERIFY: confirm govips/libvips' actual default Thumbnail interpolation kernel,
  likely Lanczos3, against libvips' own docs]`. The two are visually similar but not
  pixel-identical; this is a first concrete instance of the general question `V-2` already
  tracks, not a new category of problem. No numeric bound measured in this task — flagged,
  not solved, per CLAUDE.md's "nothing deferred silently."
- Resolve **V-5**: its trigger was "before the WebGPU/WebGL preview task doc finalizes its
  feature-detection + fallback-routing logic." That logic (`capabilities.ts`, item 4 above)
  deliberately does runtime capability probing (`requestAdapter()` success/failure) instead
  of user-agent or version sniffing, so it produces the correct backend choice regardless of
  which Safari version-numbering convention caniuse vs. the gpuweb wiki use — the
  discrepancy stops being load-bearing for correctness. Still worth a primary-source check
  someday for QA-effort planning (how much real-world traffic exercises the fallback path),
  but that's a much lower-consequence question than the one V-5 was originally tracking, so
  it doesn't block anything further and is closed here rather than left open indefinitely
  for a question this design no longer depends on.
- New **D-18**: `image.convert`/`image.compress` steps render as a **visual passthrough**
  in the live preview — no attempt to simulate JPEG/WebP/AVIF quantization artifacts or
  format-conversion appearance per-frame in a shader. Re-evaluation trigger: if a future
  editor-UX task (not `D-6`, which is about composite sliders, not raw export params) wants
  users to see compression artifacts live — e.g. a "file size vs. quality" control — that
  needs either a real-time re-encode preview (expensive, likely debounced/worker-threaded)
  or an approximated-artifact shader (a real research problem, not a shader tweak); neither
  is attempted here. See "Convert/compress" in Porquê for the reasoning.

## Porquê

**Why render-on-demand, not a `requestAnimationFrame` loop.** This is a static-image
editor, not a video timeline (explicitly out of scope per the spec's Non-Goals). A
continuous render loop would burn GPU/battery re-drawing an unchanged frame every 16ms for
no visual benefit — rendering exactly when `image` or `recipe` changes is both simpler and
strictly more correct for this workload. Should the eventual composite-slider UI (`D-6`)
need drag-time interpolation smoothing, that's a debouncing/throttling concern on *when*
`render()` is called from the UI layer, not a reason to change the renderer's own model.

**Why convert/compress get no shader treatment.** The spec's "curated composite controls"
promise (Light, Color, B&W, Sharpen) is about controls that visibly change pixels — that's
what a live preview is *for*. `image.convert`/`image.compress` don't have a "look": format
is a container choice and `quality` controls lossy-encoding artifacts that only exist after
a real encode pass. Building a shader that fakes JPEG block artifacts would be inventing
browser/codec behavior CLAUDE.md §0 explicitly warns against ("never invent... codec
behaviour"), for a feature nobody asked for yet — Apple Photos itself doesn't expose "JPEG
quality" as an editable live-preview control either, for the same reason. Recording this as
`D-18` instead of silently rendering nothing gives the eventual editor-UX task a documented
decision to revisit if it turns out users need it, rather than a mystery.

**Why the fit-mode math lives in one pure `geometry.ts`, not duplicated per backend.** The
whole reason WebGPU and WebGL2 are both "first-class" per `V-1`'s decision is that a user on
Firefox must see the *same* thing a user on Chrome sees. If the fit-inside/fit-cover math
were reimplemented once in WGSL-adjacent TS and again in GLSL-adjacent TS, any bug fix or
edge case (the degenerate-aspect-ratio case in the geometry test) would need fixing twice
and could silently drift — exactly the two-implementations-disagree failure mode the spec's
"Recipe fidelity" success metric exists to catch, just between the two *preview* backends
this time rather than preview-vs-export.

**Why this task stops at a bare demo route, not the real editor UI.** `D-6` (composite
slider → parameter mapping) is still open and needs its own design pass before any editor
layout is worth building — building real editor chrome now would mean redoing it once `D-6`
lands. A demo route that proves the rendering engine actually works in a browser (feature
detection routes correctly, resize preview matches the requested fit mode) is the honest
unit of "done" for *this* task, matching how `TASK-editor-scaffold.md` stopped at "boots a
bare Next.js app" rather than reaching into editor logic.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/geometry.ts` | new | Pure fit-mode math (`inside`/`cover`), shared by both render backends |
| `apps/web/src/lib/preview/geometry.test.ts` | new | Vitest coverage for `computeFitGeometry()`, no GPU needed |
| `apps/web/src/lib/preview/types.ts` | new | `PreviewRenderer` interface, `PreviewBackendKind` type |
| `apps/web/src/lib/preview/capabilities.ts` | new | Runtime WebGPU/WebGL2/unsupported detection — capability probing, not UA sniffing |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | new | WGSL textured-quad renderer implementing `PreviewRenderer` |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | new | GLSL ES 3.00 equivalent |
| `apps/web/src/components/PreviewCanvas.tsx` | new | Client component wiring backend selection + render-on-demand into a `<canvas>` |
| `apps/web/src/app/preview-demo/page.tsx` | new | Minimal unstyled demo route: file input + resize/fit controls |
| `apps/web/package.json` | edit | Add `@webgpu/types` devDependency |
| `docs/plexus-media-pipeline-spec.md` | edit | Cross-reference `apps/web/src/lib/preview/` from the architecture table/live-preview bullet |
| `docs/90-deferred-register.md` | edit | New `V-6` (resize resampling-kernel mismatch); resolve `V-5`; new `D-18` (convert/compress passthrough) |
| `docs/tasks/TASK-preview-renderer.md` | new | this document |
