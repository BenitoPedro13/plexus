# TASK: Cast (`castStrength`) live-preview + editor UI parity (resolve D-30)

## Cenário actual (Current scenario)

`TASK-adjust-color-cast.md` (resolved `D-27`) landed `image.adjustColor`'s `castStrength`
Go-side only: `workers/internal/processors/adjust_color.go`'s `applyCast` computes the
per-band (R/G/B) mean of the whole image (`ExtractBandToImage`+`.Average()`), scales each
band toward the mean of those three means via `img.Linear(a, b)`, blended by `castStrength`
(`0.0` = no-op, `1.0` = full grey-world correction), run *before* the existing saturation
`Modulate` call. The Zod schema (`apps/web/src/lib/recipe/schema.ts`'s
`adjustColorParamsSchema`) already has `castStrength: 0.0..1.0`, optional/defaulted to
`0.0`.

Nothing on the preview side renders it:

- `apps/web/src/lib/preview/color-math.ts`'s `applyAdjustColor` is a pure per-pixel
  function (`pixel: RGBA -> RGBA`) — it has no access to the whole-image per-band means
  `castStrength` needs, and doesn't read `params.castStrength` at all.
- `apps/web/src/lib/preview/webgpu-renderer.ts`'s `ADJUST_COLOR_WGSL` and
  `webgl2-renderer.ts`'s `ADJUST_COLOR_FRAGMENT_SHADER_SOURCE` each only bind one uniform
  float (`saturation`) and one input texture — no mechanism exists in either renderer to
  compute a full-image reduction (a mean over every pixel) before a per-pixel pass; every
  other composite pass so far (`adjustLight`, `blackAndWhite`, `sharpen`'s blur) is a pure
  elementwise or fixed-kernel-neighborhood operation, not a whole-image statistic.
- `apps/web/src/components/editor/ColorControl.tsx` renders only a `Saturation` slider; its
  own comment states "Vibrance/Cast schema+Go work not yet done" — stale since `D-27`.
- `apps/web/src/app/editor/page.tsx`'s `deriveRecipe` and `apps/web/src/app/preview-demo`'s
  recipe both hardcode `castStrength: 0` in the `image.adjustColor` step's params.
- `apps/web/src/lib/preview/drift.test.ts`'s `colorPoints` all hold `castStrength: 0` —
  `V-2`'s measured bound for Color has never seen a nonzero `castStrength` point.

This is `D-30` in `docs/90-deferred-register.md`. `D-30`'s own text already names the core
design question: computing a whole-image per-band mean is "a new per-band-mean computation
the GPU can't do per-fragment the way the existing shaders work — grey-world needs a full-
image reduction pass first, unlike the four Light params or plain saturation, which are
pure per-pixel functions."

## Mudanças planeadas (Planned changes)

**Design decision (the open question `D-30` flagged):** compute the whole-image per-band
mean entirely on the GPU, synchronously, within the same `render()` call — an iterative
2×2 box-downsample pyramid (new pipeline/program, precedented by the existing blur H/V
two-pass pattern in both renderers) that repeatedly halves a texture's dimensions
(`ceil(size/2)` each step) until it reaches 1×1, at which point that single texel holds
the average of the whole image. This is chosen over the alternative (an async GPU→CPU
buffer readback of the source pixels, averaged on the CPU) because every renderer method
today (`init`, `render`, `dispose`) is synchronous, and both `PreviewCanvas` call sites
drive `render()` once per animation frame during a live slider drag — turning one step of
one pass into an async round-trip would either stall the frame or require restructuring
the renderer's public interface for every consumer, for one control. The box-pyramid
approach stays inside the existing synchronous, single-command-encoder execution model
that every other pass already uses.

The pyramid is **not** an exact arithmetic mean when a dimension is not a power of two —
each halving step duplicates the last texel to pair up an odd count, giving edge texels
very slightly more weight than interior ones. This is a preview approximation, not a bit-
exact reimplementation, consistent with every other control in `color-math.ts` (see that
file's own top-of-file comment) — bounded and verified by the existing drift-measurement
harness (`V-2`) exactly like the other three composite controls' approximations, not a new
unverified claim requiring its own register entry.

1. **`apps/web/src/lib/preview/color-math.ts`** (edit) — add an exported
   `computeMeanRGB(pixels: RGBA[]): { r: number; g: number; b: number }` (plain arithmetic
   mean — the CPU reference doesn't need the GPU's pyramid approximation, it can compute
   the exact mean directly). Add `CAST_MEAN_EPSILON = 1e-6` (mirrors `adjust_color.go`'s
   `castMeanEpsilon`). Extend `applyAdjustColor(pixel, params, mean?)`: when
   `params.castStrength !== 0`, requires `mean` (throws if omitted — a caller bug, not a
   valid no-op, since Go always has the real image stats whenever `castStrength != 0`);
   applies the grey-world linear scale to `pixel.r/g/b` (mirrors `applyCast`'s per-band
   `scale = 1 + castStrength*(target/max(mean_c, CAST_MEAN_EPSILON) - 1)`, `target = mean of
   the three per-band means`) **before** the existing Lab/chroma saturation step, matching
   `adjust_color.go`'s pass order (cast, then `Modulate`). `castStrength === 0` skips
   entirely — `mean` stays optional and every existing call site (which never sets
   `castStrength`) needs no change.

2. **`apps/web/src/lib/preview/webgpu-renderer.ts`** (edit):
   - New `MEAN_DOWNSAMPLE_WGSL`: one `texture_2d<f32>` binding, no sampler — reads the four
     source texels a 2× box covers via `textureLoad` (clamped to the input's actual
     dimensions via `textureDimensions`, so odd sizes duplicate the last texel rather than
     reading out of bounds) and writes their average, using `@builtin(position)` in the
     fragment stage to address the *output* texel directly (framebuffer pixel coords, no
     UV/sampler needed).
   - New per-instance state: `meanChainSizes`/`meanChainTextures` — a chain of
     `ceil(prevWidth/2) x ceil(prevHeight/2)` textures computed once in `init()` from the
     source image's own dimensions, ending at 1×1 (mirrors how `texA`/`texB`/blur scratch
     textures are already sized off `source.width/height` once at init). New
     `meanDownsamplePipeline` (layout `'auto'`, one bind group entry).
   - New private `encodeMeanChain(encoder, input): GPUTexture` — runs the downsample chain
     from `input` (the texture entering the `image.adjustColor` step, full source
     resolution, exactly matching what `applyCast` computes stats over in Go: the image as
     it stands after any earlier steps in the recipe) through every `meanChainTextures`
     level, returning the final 1×1 texture.
   - `ADJUST_COLOR_WGSL`: uniform `params` gains `.y` = `castStrength`; new texture
     `binding(3) meanTexture: texture_2d<f32>`; before `rgbToLab`, apply the grey-world
     scale to `c.rgb` (mirrors `color-math.ts`'s new cast branch exactly, `1e-6` epsilon
     inlined as a WGSL const) using `textureLoad(meanTexture, vec2i(0,0), 0).rgb` as the
     per-band means.
   - `encodeAdjustmentStep`'s `image.adjustColor` case: calls `encodeMeanChain` first (even
     when `castStrength === 0` — the chain is cheap relative to the per-pixel passes already
     run every frame, and skipping it would mean two different bind-group shapes for the
     same pipeline depending on a runtime value; the scale math is an exact no-op at
     `castStrength = 0` regardless of what `meanTexture` holds), then
     `encodeUniformPass(..., [saturation, castStrength], [input, meanTexture], output)`.
   - `dispose()`: destroy the new chain textures.

3. **`apps/web/src/lib/preview/webgl2-renderer.ts`** (edit) — mirrors (2) on the GLSL side:
   `MEAN_DOWNSAMPLE_FRAGMENT_SHADER_SOURCE` using `texelFetch`/`textureSize`/`gl_FragCoord`
   (same clamped-2×2-box logic); a chain of `WebGLTexture`+`WebGLFramebuffer` pairs sized at
   `init()` from the source image's dimensions down to 1×1; `ADJUST_COLOR_FRAGMENT_SHADER_SOURCE`
   gains a `uMean` `sampler2D` uniform (read via `texelFetch(uMean, ivec2(0,0), 0)`, so no
   filtering/sampler-state concerns) and reads `castStrength` off the existing `uParams.y`
   slot (already a `vec4`, room for 4 values — no second uniform chunk needed, unlike
   `adjustLight`'s six params); `buildContentProgram(ADJUST_COLOR_FRAGMENT_SHADER_SOURCE, ['uSource', 'uMean'])`;
   `runAdjustmentStep`'s `image.adjustColor` case runs the new downsample chain, then
   `runContentPass` with both textures bound. `dispose()` cleans up the new chain
   textures/framebuffers.

4. **`apps/web/src/components/editor/ColorControl.tsx`** (edit) — props change from
   `saturation: number` / `onChange: (saturation: number) => void` to
   `value: AdjustColorParams` / `onChange: (next: AdjustColorParams) => void`, matching
   `LightControl`/`BlackAndWhiteControl`'s existing `value`/`onChange` object shape instead
   of a lone scalar prop. Add a direct `Cast` range input (`0..1`, step `0.05`) alongside
   `Saturation` — no `<details>`/"Adjust manually" fold, matching `BlackAndWhiteControl`'s
   precedent: a small curated set of raw params with no fan-out master blend gets direct
   sliders, the fold is reserved for controls that also expose a blended master slider
   (`LightControl`'s `Light` slider via `applyLightBlend`). Update the stale top-of-file
   comment.

5. **`apps/web/src/app/editor/page.tsx`** (edit) — `EditState.saturation: number` becomes
   `color: AdjustColorParams` (initial `{ saturation: 0, castStrength: 0 }`), matching the
   existing `light: AdjustLightParams` / `bw: BlackAndWhiteParams` pattern.
   `deriveRecipe`'s guard becomes `state.color.saturation !== 0 || state.color.castStrength !== 0`
   (same bug shape `D-25`'s implementation found and fixed for
   highlights/shadows — a step must still be emitted when only the second param moves from
   identity); the step's `params` becomes `state.color` directly. `<ColorControl>` usage
   updated to the new `value`/`onChange` shape.

6. **`apps/web/src/app/preview-demo/page.tsx`** (edit) — add a `castStrength` slider
   (`useState(0)`, range `0..1`) to the existing `Color` `fieldset`, wired into the
   `image.adjustColor` step's params (replacing the hardcoded `castStrength: 0`).

7. **`workers/cmd/gendriftgolden/main.go`** (edit) — add two isolated points to the
   `image.adjustColor` group: `color-cast-0.5` (`castStrength: 0.5`, `saturation: 0`) and
   `color-cast-1.0` (`castStrength: 1.0`, `saturation: 0`) — same "isolated single-param
   point" convention `D-25` used for highlights/shadows, so drift is attributable to the
   new mean-reduction pass specifically, not mixed with the existing near-bit-exact
   saturation path. Regenerate (`go run ./cmd/gendriftgolden` — `pkg-config --modversion vips`
   confirmed `8.18.5` locally), producing two new committed `testdata/drift/golden/*.rgba`
   files; existing points re-derived byte-identical (diff-check before committing, same as
   `D-25`'s precedent).

8. **`apps/web/src/lib/preview/drift.test.ts`** (edit) — import `computeMeanRGB`; compute
   `const sourceMeanRGB = computeMeanRGB(source.pixels)` once at module scope (the color
   points test `image.adjustColor` in isolation directly against `source.pixels`, so the
   mean over the untouched source raster is the correct reference — matches what
   `applyCast` computes in Go for a recipe where `image.adjustColor` is the first/only
   step). Add the two new points to `colorPoints`; `it.each` passes `sourceMeanRGB` as
   `applyAdjustColor`'s third argument. Log measured MAE/max/ΔE first — the box-pyramid
   mean is new math with no existing coverage — and widen `COLOR_BOUNDS` only if the
   measured worst case exceeds the current bound (mae 0.25 / max 1.0 / meanDeltaE 0.2),
   same "~1.3-1.7x worst observed" margin convention already documented in this file, with
   the real numbers recorded inline.

9. **`apps/web/src/lib/preview/color-math.test.ts`** (edit) — new tests: `computeMeanRGB`
   on a small fixed pixel array; `applyAdjustColor` with `castStrength` — `0` is a no-op
   regardless of `mean` (existing tests keep passing unchanged); a synthetic color-cast
   pixel set converges toward the mean as `castStrength -> 1`; omitting `mean` while
   `castStrength !== 0` throws.

10. **`docs/90-deferred-register.md`** (edit) — resolve `D-30` with what was measured and
    decided (GPU box-pyramid mean reduction, synchronous/no-readback design matching the
    renderers' existing execution model, direct-slider UI per `BlackAndWhiteControl`'s
    precedent, measured drift bound outcome). Note the pyramid's non-power-of-two bias
    explicitly as a bounded approximation (per `V-2`'s existing mandate), not a new `V-xx`.

11. **`docs/plexus-media-pipeline-spec.md`** (edit) — its Open Questions line for the
    composite-slider mapping currently reads "...live-preview/editor-UI parity remains open
    (`D-30`, same shape as `D-25`)" — update once `D-30` is resolved, mirroring how the same
    line was updated when `D-27`/`D-25` landed.

## Porquê (Why)

`D-30` was opened in the same pass that landed `castStrength` Go-side, deliberately scoped
out because grey-world white balance is a genuinely different shape of computation from
every other composite control shipped so far — a whole-image reduction, not a pure
per-pixel function — and needed its own design pass rather than a drop-in shader mirroring
`adjustLight`/`blackAndWhite`'s pattern.

The GPU box-pyramid keeps the mean computation inside the same synchronous,
single-command-encoder model every other pass in both renderers already uses. The
alternative — reading pixels back to the CPU to compute an exact mean — would require an
async `render()` (a `GPUBuffer.mapAsync`/`gl.readPixels`-into-a-promise round-trip) that no
other part of either renderer's public interface has, for the sake of one control's exact
sub-pixel precision; the box-pyramid's bias (edge-texel duplication on non-power-of-two
dimensions) is a small, boundable approximation error of exactly the kind `V-2`'s drift
harness already exists to catch and quantify per control, not a correctness gap.

Not folding `Cast` behind an "Adjust manually" disclosure matches `BlackAndWhiteControl`'s
already-established precedent over `LightControl`'s: the fold exists specifically to hide
raw params *behind* a fan-out master blend slider, and Color has no such master slider (its
single `Saturation` value already *is* the raw param, same as B&W's three). Adding a master
"Color" blend ratio for saturation+cast is its own undecided UI judgment call (`D-22`'s
existing scope), out of this task for the same reason `D-25` kept highlights/shadows off
the `Light` master blend.

## Ficheiros afectados (Affected files)

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/color-math.ts` | edit | `computeMeanRGB`; extend `applyAdjustColor` with an optional `mean` param for the cast branch |
| `apps/web/src/lib/preview/color-math.test.ts` | edit | new tests for `computeMeanRGB` and `applyAdjustColor`'s castStrength behavior |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | new mean-downsample pyramid pipeline + chain textures; `ADJUST_COLOR_WGSL` reads `castStrength` + `meanTexture` |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | mirrors WebGPU: mean-downsample pyramid program + chain textures/FBOs; `ADJUST_COLOR_FRAGMENT_SHADER_SOURCE` reads `castStrength` + `uMean` |
| `apps/web/src/components/editor/ColorControl.tsx` | edit | `value`/`onChange` object shape; add direct `Cast` slider |
| `apps/web/src/app/editor/page.tsx` | edit | `EditState.color: AdjustColorParams` replacing `saturation: number`; `deriveRecipe` guard fix |
| `apps/web/src/app/preview-demo/page.tsx` | edit | add `castStrength` slider to the Color fieldset |
| `workers/cmd/gendriftgolden/main.go` | edit | add `color-cast-0.5`/`color-cast-1.0` points |
| `testdata/drift/golden/color-cast-0.5.rgba` | new | regenerated golden fixture |
| `testdata/drift/golden/color-cast-1.0.rgba` | new | regenerated golden fixture |
| `apps/web/src/lib/preview/drift.test.ts` | edit | add the two new points to `colorPoints`; adjust `COLOR_BOUNDS` only if measurement requires it |
| `docs/90-deferred-register.md` | edit | resolve `D-30` |
| `docs/plexus-media-pipeline-spec.md` | edit | update the composite-slider-mapping Open Questions line |
| `apps/web/src/lib/preview/geometry.ts` | edit | new `computeMeanChainSizes` (shared by both renderers) |

---

## Implemented 2026-08-07 — deviations from the plan above

Landed close to the plan; one addition not in the original file list, everything else
matched:

- **`apps/web/src/lib/preview/geometry.ts` gained `computeMeanChainSizes`** — not in the
  original affected-files table. The chain-size computation (`ceil(size/2)` per step down
  to 1×1) is pure geometry, identical for both backends, and `geometry.ts` already is the
  "both renderers import this" module for `computeFitGeometry`/`findLastResizeStep` — adding
  a third shared pure function there instead of duplicating the loop in both
  `webgpu-renderer.ts` and `webgl2-renderer.ts` followed that existing precedent rather than
  the plan's implicit assumption that chain-size logic would live inside each renderer.
- **Uniform/texture wiring matched the plan exactly**: `ADJUST_COLOR_WGSL`'s existing
  `vec4f` uniform had room for `castStrength` at `.y` (no second uniform chunk needed, unlike
  `adjustLight`'s six params) — same for WebGL2's existing `uParams` `vec4`. The mean chain
  runs unconditionally on every `image.adjustColor` step, as planned (avoids a
  castStrength-dependent bind-group shape).
- **Drift measurement**: existing golden fixtures regenerated byte-identical (confirmed via
  `git status` showing only the two new `color-cast-*.rgba` files). Measured drift for both
  new points came back effectively bit-exact (mae≈0.000016, max≈0.0001, meanΔE≈0.000007) —
  `computeMeanRGB` computes the exact arithmetic mean (matching govips's `Average()`
  exactly) and both sides run the identical linear-scale formula, so this is closer to
  bit-exact than even the saturation points. No bound widening needed, only the inline
  comment updated with the real numbers.
- **A real, explicitly-flagged gap, consistent with `D-25`'s own precedent**: the drift
  harness only exercises `color-math.ts`'s TS reference against Go — it does not run the
  actual WGSL/GLSL shaders in a browser, so the GPU renderers' box-downsample-pyramid mean
  (and its non-power-of-two edge-texel bias) has not been measured against a real image with
  odd dimensions. Noted in both `COLOR_BOUNDS`'s inline comment and `D-30`'s resolution
  entry rather than silently left out.

Verified: `go build ./...`, `go vet ./...`, `golangci-lint run ./...` (0 issues), `go test
./internal/processors/...` (pass, cached — no Go processor logic changed, only
`gendriftgolden/main.go`). TS side: `pnpm tsc --noEmit` (clean), `pnpm lint` (clean),
`pnpm test` (114/114, up from 105/105 — 9 new tests: 5 `applyAdjustColor` castStrength
tests, 2 `computeMeanRGB` tests, 2 new `drift.test.ts` Color points). Not verified: actual WebGPU/WebGL2 shader
compilation and visual output in a real browser — same limitation `D-25` documented, left to
the user's own manual check at `localhost:3000/editor` and `/preview-demo`.
