# TASK-composite-preview-shaders — WebGPU/WebGL2 shaders for the four composite processors (Phase 2, D-19)

## Cenário actual

`apps/web/src/lib/preview/` (`TASK-preview-renderer.md`) has a working dual-path live
preview: `WebGPURenderer` and `WebGL2Renderer` (`webgpu-renderer.ts`, `webgl2-renderer.ts`)
both implement `PreviewRenderer.render(recipe: Recipe)` as a **single full-canvas quad
pass**. That pass does exactly one thing: it samples the original source texture through a
UV rect computed by `computeFitGeometry()` (`geometry.ts`), which reads only the *last*
`image.resize` step in the recipe (`findLastResizeStep()`) to decide crop/scale. Every other
step type — `image.convert`, `image.compress`, and now the four composite processors — is
invisible to the renderer; the shader has no uniforms, no branching, no per-pixel math
beyond a bilinear texture sample. `PreviewCanvas.tsx` drives this: it re-calls
`renderer.render(recipe)` on every recipe change (no rAF loop, static-image editor).

Meanwhile `workers/internal/processors/` (`TASK-composite-processors-go.md`, landed as
commit `01204f6`) now implements four real Go processors with concrete govips calls:

| Processor id | Params | Go operation |
|---|---|---|
| `image.adjustLight` | `exposure`, `brightness`, `contrast`, `blackPoint` | four chained `Linear1` passes (exposure → brightness → contrast → blackPoint, in that order), `blackPoint`'s denominator floored at `1e-6` |
| `image.adjustColor` | `saturation` | `img.Modulate(1, 1+saturation, 0)` — converts to `InterpretationLCH`, scales chroma, converts back |
| `image.blackAndWhite` | `intensity`, `neutrals`, `tone` | `Recomb` (3×3 grayscale matrix skewed by `neutrals`) → `Linear1` contrast (`tone`) → linear blend with the original by `intensity` |
| `image.sharpen` | `intensity` | `img.Sharpen(0.5, 2, 3*intensity)` — libvips unsharp mask, `sigma`/`x1` fixed |

The Zod schema (`apps/web/src/lib/recipe/schema.ts`, `TASK-composite-processors-schema.md`)
already types all four as valid `RecipeStep`s. So today: a recipe containing
`image.adjustLight` (or any of the other three) validates fine, dispatches fine on the Go
side, and renders as a **no-op** in the live preview — the editor's whole premise ("drag a
slider, see the result immediately, no server round-trip") is broken for exactly the four
controls Phase 2's composite-slider work exists to support. This is the gap D-19 named as
"next task" after the Go processors landed.

Two things this task inherits and does not re-litigate:

- **V-1 / the dual-backend requirement**: everything below is implemented twice — once in
  WGSL for `WebGPURenderer`, once in GLSL ES 3.00 for `WebGL2Renderer` — because Firefox
  still lacks default WebGPU support.
- **D-18 (`image.convert`/`image.compress` stay a visual no-op)**: unaffected by this task,
  not revisited.

## Mudanças planeadas

### Central decision: true ordered multi-pass rendering, not a fixed-order single shader

The mapping doc already established the contract that matters here
(`TASK-composite-slider-mapping.md`, line 92): *"`image.blackAndWhite` is just another
recipe step, applied after `image.adjustColor` when present — recipe steps are already a
linear ordered stack, so 'B&W overrides color' needs no special-casing."* Go's execution
model runs `recipe.steps` strictly in array order, mutating the image in place at each step.
For the preview to match — the whole point of recipe/pipeline unification, and the thing
CLAUDE.md calls out by name as the failure mode to avoid ("export doesn't match the preview
the user approved") — the shader pipeline has to honor **actual recipe step order**, not a
hardcoded "Light, then Color, then B&W, then Sharpen" sequence baked into one shader. A fixed
canonical order would be simpler to implement, but it's wrong for any recipe not produced by
the editor's own fixed slider layout — including hand-authored batch-pipeline YAML, which
the mapping doc explicitly anticipates ("a YAML pipeline author writes `image.sharpen`
without dragging in unrelated Light/Color"). Rejected for that reason.

Chosen approach: extend both renderers from "one quad pass" to **N ordered off-screen
passes + one final blit**:

1. Walk `recipe.steps` in array order (not just the last match, unlike `findLastResizeStep`
   — every occurrence of a content-adjustment step gets its own pass, since a recipe that
   repeats a processor is legal and Go would apply it twice).
2. For each step whose `processor` is one of the four composite ids, run a dedicated
   full-screen fragment-shader pass reading from a source texture and writing to an
   off-screen render target, ping-ponging between two textures sized to the **original
   source image's dimensions** (not the final canvas size — content passes run before the
   geometry crop/scale, matching Go where resize is just another step that happens to change
   dimensions).
3. `image.resize` steps are **not** turned into a real resampling pass this task — geometry
   stays exactly as `TASK-preview-renderer.md` built it: `findLastResizeStep()` picks the
   last resize step, `computeFitGeometry()` turns it into a UV rect, and the *existing* final
   blit shader (already in both renderers) samples through that rect into the visible
   canvas. This is a known, deliberate simplification — see new `D-21` below.
4. Final pass: the current UV-rect blit shader, unchanged, sampling from whichever
   ping-pong texture holds the result of step 2 (or the original texture, if the recipe has
   no composite-adjustment steps — today's behavior, preserved exactly).

This makes `render()` cost proportional to recipe length (N+1 draw calls instead of 1), which
is fine for a static-image editor with no rAF loop and recipes on the order of single-digit
steps.

### 1. `apps/web/src/lib/preview/color-math.ts` (new)

Pure TypeScript, no DOM/GPU dependency — the reference implementation every WGSL/GLSL
snippet below is hand-transcribed from, and the only part of this task unit-testable without
a real browser (mirrors `geometry.ts`'s role in `TASK-preview-renderer.md`). Operates on
`{ r, g, b, a }` in normalized `0..1` space (shader-native), not `0..255` (Go-native) —
callers convert at the boundary. Exports:

- `applyAdjustLight(pixel, params: AdjustLightParams)`: the four chained affine transforms
  in Go's exact order, translated to `0..1` space (`exposure` → `pow(2, exposure)`
  multiply; `brightness` → `+brightness`; `contrast` → `*(1+contrast) - 0.5*contrast`;
  `blackPoint` → `(x - blackPoint) / max(1 - blackPoint, 1e-6)`), applied to **R, G, B only
  — alpha passed through unchanged**. See new `D-20`: Go's `Linear1` calls apply uniformly
  to every band including alpha (no alpha exemption in `adjust_light.go`), which is
  invisible for the opaque images this editor mostly handles but is a real, deliberate
  divergence from Go for genuinely transparent inputs — replicating Go's alpha-mutating
  behavior in the preview would make partially-transparent images visibly fade in/out as
  brightness/contrast are dragged, which is a worse user-facing bug than the divergence
  itself.
- `applyAdjustColor(pixel, params: AdjustColorParams)`: sRGB → linear RGB → CIE XYZ (D65) →
  CIE Lab → LCh, scale chroma `C *= (1 + saturation)`, convert back. Standard CIE 1976
  Lab/LCh formulas (Bruce Lindbloom's reference coefficients), not vips-specific — but
  **`Modulate`'s exact white point and gamut-clamping behavior on the round trip back to
  sRGB is `[VERIFY]`**, tracked as new `V-11` below, since that's the one place a wrong
  assumption would silently mis-render every hue.
- `applyBlackAndWhite(pixel, params: BlackAndWhiteParams)`: `grayscaleMatrix(neutrals)`'s
  exact weights ported from `black_and_white.go` (`green = 1/3 + neutrals/3`, `redBlue =
  (1-green)/2`), dot-product grayscale, `tone` as the same affine-contrast formula as
  `adjustLight`'s `contrast`, then `mix(original.rgb, toned, intensity)`. No Lab conversion
  needed — `Recomb` is a direct RGB matrix multiply.
- `applyUnsharpMask(pixel, blurredPixel, intensity)`: `pixel + 3*intensity * (pixel -
  blurredPixel)`, the unsharp-mask half of the sharpen pass (the Gaussian-blur half is a
  separate spatial pass, not expressible as a per-pixel function — see file 2/3 below).
  **Whether libvips' `sharpen` operates on L-only (LAB) or full RGB is `[VERIFY]`**, tracked
  as new `V-10` — this function is written to take a `colorSpace: 'rgb' | 'lab-l'` flag so
  the renderers can switch once V-10 resolves without redesigning the pass.
- `collectOrderedAdjustmentSteps(recipe: Recipe)`: returns every step (in original array
  order, duplicates included) whose `processor` is one of the four composite ids, typed as a
  discriminated union — the single source both renderers iterate over in file 2/3, so the
  ordering logic itself is unit-tested once rather than twice.

### 2. `apps/web/src/lib/preview/webgpu-renderer.ts` (edit)

- Add four new WGSL fragment shaders (adjustLight, adjustColor, blackAndWhite) sharing the
  existing full-screen-quad vertex shader, plus a two-pass sharpen (separable Gaussian blur
  sized to `sigma=0.5` — a 3-tap kernel is enough at that sigma — then the unsharp
  composite), each transcribed from `color-math.ts`.
- Add a ping-pong pair of `GPUTexture`s (`rgba8unorm`, `RENDER_ATTACHMENT | TEXTURE_BINDING`,
  sized to `sourceDimensions`) and per-step uniform buffers.
- `render()`: replace the single draw call with the ordered-passes algorithm above, using
  `collectOrderedAdjustmentSteps()` to decide which pipeline runs each iteration.
- `dispose()`: destroy the new textures/buffers alongside the existing ones.

### 3. `apps/web/src/lib/preview/webgl2-renderer.ts` (edit)

Same shape in GLSL ES 3.00 + `WebGLFramebuffer`/`WebGLTexture` ping-pong instead of
`GPUTexture`, mirroring file 2 pass-for-pass so the two backends stay provably equivalent
(same rationale as the existing vertex-shader/UV-flip comments already in both files).

### 4. `apps/web/src/lib/preview/color-math.test.ts` (new)

Vitest, boundary + directional assertions in the same style as the Go golden-fixture tests
(`TASK-composite-processors-go.md`) — not exact-float predictions, since this is an
approximation of a real encode pipeline by design:

- `adjustLight`: `exposure=0/brightness=0/contrast=0/blackPoint=0` is identity;
  `blackPoint=1.0` clips to black without producing `NaN`/`Infinity` (mirrors the Go
  divide-by-zero guard this task inherits, not re-derives); `exposure>0` strictly brightens
  a mid-gray input.
- `adjustColor`: `saturation=0` is identity (within float tolerance, since a full
  sRGB→Lab→sRGB round trip isn't exactly lossless); `saturation=-1` fully desaturates
  (R=G=B); `saturation>0` increases the max-min channel spread on a non-gray input.
- `blackAndWhite`: `intensity=0` is identity; `intensity=1` produces R=G=B; `neutrals`
  swings the gray weight the same direction `grayscaleMatrix()` does in Go.
- `collectOrderedAdjustmentSteps`: preserves recipe order, includes duplicates, ignores
  `image.resize`/`image.convert`/`image.compress`.

Actual GPU-pipeline correctness (do the WGSL/GLSL passes actually run and match
`color-math.ts`'s output) is **not** committed-CI-testable today — no Playwright/Puppeteer
harness exists in this repo yet, same gap `TASK-preview-renderer.md` had. Verified instead
the same way that task was: a real headless-Chromium run per backend during this task,
documented in the commit message, not just asserted.

### 5. `docs/90-deferred-register.md` (edit)

New entries — `V-10`, `V-11`, `D-20`, `D-21` as described inline above — added in the same
pass as the code, per CLAUDE.md §3.

## Porquê

D-19 named this as the next task once the Go processors landed: the four composite sliders
are now fully wired server-side but invisible client-side, which means every one of them
currently violates the editor's core promise ("live client-side preview via WebGPU... no
server round-trip per adjustment," spec §Architecture). The ordered-multi-pass architecture
(vs. a simpler fixed-order single shader) is the more expensive choice but is the one that
actually satisfies "recipe/pipeline unification... no translation step" — CLAUDE.md's own
"things that must not break" list — for recipes that don't originate from the editor's fixed
slider layout. Doing the cheaper fixed-order version now and fixing it later would mean
either a silent preview/export mismatch for hand-authored pipelines, or a rewrite once
someone hits it; the mapping doc already flagged this exact ordering concern for B&W-after-
Color, so it's not a hypothetical.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/color-math.ts` | new | pure-TS reference math for all four processors + step-ordering helper |
| `apps/web/src/lib/preview/color-math.test.ts` | new | Vitest boundary/directional coverage |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | ping-pong render targets, 5 new WGSL passes (4 processors, sharpen split into blur+composite), ordered `render()` |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | same, GLSL ES 3.00 + FBO ping-pong |
| `docs/90-deferred-register.md` | edit | new `V-10`, `V-11`, `D-20`, `D-21` |
