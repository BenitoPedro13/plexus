# TASK: Highlights/Shadows live-preview + editor UI parity (resolve D-25)

## Cenário actual (Current scenario)

`TASK-highlights-shadows-tonelut.md` (resolved `V-7`) landed `image.adjustLight`'s
`highlights`/`shadows` params Go-side only: `workers/internal/processors/adjust_light.go`
applies them as a `ToColorSpace(LABS)` → `Tonelut(S, H)` → `Maplut` pass on the L band,
after the four RGB `Linear1` passes (exposure/brightness/contrast/blackPoint). The Zod
schema (`apps/web/src/lib/recipe/schema.ts`'s `adjustLightParamsSchema`) already has both
fields, defaulted to `0.0`.

Nothing on the preview side renders them:

- `apps/web/src/lib/preview/color-math.ts`'s `applyAdjustLight` only implements the RGB
  affine chain (exposure/brightness/contrast/blackPoint) — `highlights`/`shadows` are
  accepted by the type but never read.
- `apps/web/src/lib/preview/webgpu-renderer.ts`'s `ADJUST_LIGHT_WGSL` and
  `webgl2-renderer.ts`'s `ADJUST_LIGHT_FRAGMENT_SHADER_SOURCE` each pass exactly 4 floats
  (`vec4f`/`vec4`) to the shader — no room for two more params in the current uniform
  layout.
- `apps/web/src/lib/editor/light-blend.ts`'s `applyLightBlend` hardcodes
  `highlights: 0, shadows: 0` — the master "Light" slider can't reach them.
- `apps/web/src/components/editor/LightControl.tsx`'s "Adjust manually" `<details>` block
  has sliders for the original four params only.
- `apps/web/src/lib/preview/drift.test.ts`'s Light control points (`light-mild`,
  `light-strong`) both hold `highlights: 0, shadows: 0` — `V-2`'s measured bound for Light
  has never seen a nonzero highlights/shadows point, so there's no evidence the preview
  approximation (once written) is actually close to the Go ground truth for these two
  params specifically.

This is `D-25` in `docs/90-deferred-register.md`.

**libvips' `tonelut` curve, confirmed from primary source** (`libvips/create/tonelut.c`,
`github.com/libvips/libvips`, fetched this session — not re-derived from memory, per
CLAUDE.md §0's "never invent"): with `Lb=0, Lw=100, Ps=0.2, Pm=0.5, Ph=0.8` (libvips'
defaults, left untouched by `adjust_light.go`), the derived positions are `Ls=20, Lm=50,
Lh=80`, and

```
tone_curve(x) = x + S*shad(x) + H*high(x)   // M*mid(x) omitted: adjust_light.go never sets M
```

where `shad`/`high` are Hermite (`3t²-2t³`) smoothstep bumps. The source's own piecewise
definition is exactly reproduced by the two built-in `smoothstep()` calls:

```
shad(x) = smoothstep(Lb, Ls, x) - smoothstep(Ls, Lm, x)   // peak 1 at x=Ls=20
high(x) = smoothstep(Lm, Lh, x) - smoothstep(Lh, Lw, x)   // peak 1 at x=Lh=80
```

(Verified algebraically: `smoothstep(e0,e1,x)` already clamps `t=(x-e0)/(e1-e0)` to `[0,1]`
before applying `3t²-2t³`, which reproduces each of `shad`/`high`'s four-branch definition
exactly at every branch boundary — no separate piecewise `if` chain needed in WGSL/GLSL.)
`x` is L* on libvips' 0–100 scale, matching `color-math.ts`'s existing `rgbToLab`/`labToRgb`
(D65, CIE76) output range exactly — no rescaling needed to reuse the existing Lab helpers.
`S`/`H` are `adjust_light.go`'s already-decided sign convention: `S = shadows*30`,
`H = -highlights*30` (highlights positive = darker/recovered, Apple Photos convention,
negated from libvips' raw `H`).

## Mudanças planeadas (Planned changes)

1. **`apps/web/src/lib/preview/color-math.ts`** (edit) — add an exported
   `highlightsShadowsL(l, highlights, shadows): number` implementing the curve above
   (pure function, 0–100 domain, clamped to `[0, 100]` matching Go's LUT clamp). Extend
   `applyAdjustLight`: after the existing RGB `transform()` chain, if `highlights !== 0 ||
   shadows !== 0`, convert to Lab (`rgbToLab`, already exported), replace `l` with
   `highlightsShadowsL(lab.l, highlights, shadows)`, convert back (`labToRgb`, currently
   private — export it, no behavior change). Skips the Lab round-trip entirely when both
   are `0` (matches Go's own `if highlights != 0 || shadows != 0` branch in
   `adjust_light.go`, and avoids an unnecessary Lab conversion on the common no-op case).

2. **`apps/web/src/lib/preview/webgpu-renderer.ts`** (edit):
   - `ADJUST_LIGHT_WGSL` gains `LAB_HELPERS_BLOCK` (already defined in this file, reused
     by `ADJUST_COLOR_WGSL`/`UNSHARP_WGSL`) and a WGSL `highlightsShadowsL` mirroring the
     TS function above (`smoothstep` is a WGSL builtin).
   - Uniform layout: `encodeUniformPass`/its buffer generalize from a fixed 4-float
     `vec4f` to `ceil(n/4)` vec4-sized chunks in one buffer (`array<vec4f, 2>` for
     `adjustLight`'s 6 values: `exposure, brightness, contrast, blackPoint, highlights,
     shadows`, padded to 8). Every other content pass still passes ≤4 values, so this is a
     behavior-preserving generalization, not a special case bolted on.
   - `encodeAdjustmentStep`'s `image.adjustLight` case passes all six params instead of
     four.

3. **`apps/web/src/lib/preview/webgl2-renderer.ts`** (edit) — mirrors (2) on the GLSL
   side: `ADJUST_LIGHT_FRAGMENT_SHADER_SOURCE` gains `LAB_HELPERS_GLSL` +
   `highlightsShadowsL`; `ContentProgram`/`buildContentProgram`/`runContentPass` generalize
   from one `uParams` `vec4` location to an array of chunk locations (`uParams[0]`,
   `uParams[1]` via `uniform vec4 uParams[2];` when a program needs >4 values — every
   other program keeps its existing plain `uniform vec4 uParams;` declaration and a
   single-location array, so no other shader source changes); `runAdjustmentStep`'s
   `image.adjustLight` case passes all six params.

4. **`apps/web/src/components/editor/LightControl.tsx`** (edit) — add `Highlights`/
   `Shadows` range inputs (`-1..1`, step `0.05`, matching the existing four) to the
   "Adjust manually" `<details>` block, same pattern as `Exposure`/`Brightness`/etc. The
   master "Light" slider (`applyLightBlend`) is **not** touched — it still sets
   `highlights: 0, shadows: 0`. Folding highlights/shadows into the single master blend
   ratio is its own UI/UX judgment call (same shape as `D-22`'s existing note on the
   other four ratios), deliberately out of scope here to avoid re-opening that already-
   deferred decision as a side effect of a preview-parity task.

5. **`workers/cmd/gendriftgolden/main.go`** (edit) — add two new points to the
   `image.adjustLight` group: `light-shadows-strong` (`shadows: 0.7`, everything else 0)
   and `light-highlights-strong` (`highlights: 0.7`, everything else 0) — isolated
   single-param points so drift attributable to the new Lab pass isn't mixed with the
   existing RGB-chain params. Regenerate (`go run ./cmd/gendriftgolden` — libvips
   confirmed locally installed, `pkg-config --modversion vips` → `8.18.5`), producing two
   new committed `testdata/drift/golden/*.rgba` files (existing points are re-derived
   byte-identically since their params are unchanged — Go processors are deterministic
   for a fixed input/param pair, but will diff-check before committing).

6. **`apps/web/src/lib/preview/drift.test.ts`** (edit) — add the two new points to
   `lightPoints`. First run: log measured MAE/max/ΔE against the current `LIGHT_BOUNDS`
   (mae 0.6 / max 1.5 / meanDeltaE 0.4) without assuming they still hold — the Lab
   round-trip this task adds is new math, not already covered by the existing near-bit-
   exact RGB-chain measurement. Widen `LIGHT_BOUNDS` only if the new points' measured
   worst-case exceeds the current bound, using the same "~1.3-1.7x worst observed" margin
   convention already documented in this file, with the real numbers recorded inline.

7. **`docs/90-deferred-register.md`** (edit) — resolve `D-25` with what was measured and
   decided (Lab-space tonelut-equivalent curve, uniform-layout generalization, manual-only
   UI exposure). Note the master-blend-ratio question for highlights/shadows as still open
   (fold into `D-22`'s existing scope rather than opening a new ID, since it's the same
   "Light master slider blend ratios are a UI judgment call" question `D-22` already
   tracks).

8. **Type-ripple only, no behavior change**: none expected — `AdjustLightParams` already
   has `highlights`/`shadows` as required-with-default fields since `V-7` landed, so no
   call site needs updating for the type to keep compiling.

## Porquê (Why)

`D-25` was opened in the same pass that landed the Go-side params, deliberately scoped out
because "the mapping formula for a WGSL/GLSL-side `tonelut`-equivalent... is its own design
question" (`TASK-highlights-shadows-tonelut.md`'s own words). That design question is now
answered from libvips' primary source rather than guessed: the four-branch piecewise
`shad`/`high` functions collapse to two `smoothstep()` calls each, which both WGSL and GLSL
ES 300 provide as builtins — cheap enough to run per-pixel per-frame with no lookup table,
matching every other composite control's shader approach in this codebase.

Doing the drift measurement in the same task (not a follow-up) matches how
`TASK-recipe-fidelity-drift.md` treated the original four Light params — a preview
approximation ships with a measured bound from the start, not "add the shader now, measure
later." Isolating the two new points to single-param changes (rather than blending into the
existing mild/strong combined points) makes it possible to tell, from the numbers alone,
whether any bound blowup comes from the new Lab pass specifically or from interaction with
the existing RGB chain.

Not wiring highlights/shadows into the master "Light" blend slider is a deliberate scope
cut, not an oversight: `D-22` already flags the existing four ratios (`exposure*1.5`,
`brightness*0.3`, etc.) as a first-pass judgment call with no source of truth to validate
against (Apple Photos is closed-source). Adding two more judgment-call ratios inside a task
whose actual subject is shader math would bury a UI decision inside a rendering task, the
same mistake the original `D-19`/`D-25` split was written to avoid. Manual sliders give
real, recipe-correct access to both params today without pre-committing to a blend ratio no
one has validated.

## Ficheiros afectados (Affected files)

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/color-math.ts` | edit | export `highlightsShadowsL` + `labToRgb`; extend `applyAdjustLight` with the Lab-space pass |
| `apps/web/src/lib/preview/color-math.test.ts` | edit | new `describe` block: directional tests for `highlightsShadowsL`/`applyAdjustLight`'s highlights/shadows behavior |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | `ADJUST_LIGHT_WGSL` gains Lab helpers + curve fn; uniform-buffer helper generalized to N vec4 chunks |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | `ADJUST_LIGHT_FRAGMENT_SHADER_SOURCE` mirrors WGSL; `ContentProgram`/`runContentPass` generalized to N vec4 chunks |
| `apps/web/src/components/editor/LightControl.tsx` | edit | add Highlights/Shadows manual sliders |
| `workers/cmd/gendriftgolden/main.go` | edit | add `light-shadows-strong`/`light-highlights-strong` points |
| `testdata/drift/golden/light-shadows-strong.rgba` | new | regenerated golden fixture |
| `testdata/drift/golden/light-highlights-strong.rgba` | new | regenerated golden fixture |
| `apps/web/src/lib/preview/drift.test.ts` | edit | add the two new points to `lightPoints`; adjust `LIGHT_BOUNDS` only if measurement requires it |
| `docs/90-deferred-register.md` | edit | resolve `D-25`; note master-blend-ratio question folded into `D-22` |

---

## Implemented 2026-08-07 — deviations from the plan above

Landed close to the plan, with one real bug found only by re-reading the surrounding code,
not predicted by the design:

- **`apps/web/src/app/editor/page.tsx`'s `deriveRecipe` bug**: not in the original plan.
  Its condition for emitting an `image.adjustLight` step checked only the original four
  params (`exposure/brightness/contrast/blackPoint !== 0`) — dragging *only* the new
  Highlights/Shadows manual sliders from identity would have silently produced a recipe
  with no `image.adjustLight` step at all, so the preview (correctly showing nothing,
  since no step means no-op) would have quietly disagreed with what a user watching the
  sliders move would expect. Fixed by extending the condition to include
  `highlights !== 0 || shadows !== 0`.
- **Uniform-layout generalization matched the plan almost exactly**: `encodeUniformPass`
  (WebGPU) now chunks into `ceil(n/4)` vec4f slots instead of a fixed one; the WebGL2 side
  used a slightly different mechanism than originally sketched (a second named uniform
  `uParams2` + `paramsLocation2`, rather than a GLSL array uniform with per-element
  locations) — simpler to wire given `getUniformLocation` already returns `null` (a safe
  no-op for `gl.uniform4f`) for programs that don't declare `uParams2`, so no per-program
  branching was needed in `buildContentProgram`.
- **`tonelut`'s piecewise curve reduces to `smoothstep()` exactly**, confirmed
  algebraically against `libvips/create/tonelut.c`'s four-branch `shad`/`high` before
  writing any shader code — no lookup table, no manual branch-per-region logic needed in
  either WGSL or GLSL.
- **Drift measurement**: existing golden fixtures regenerated byte-identical (confirmed via
  `git status` showing only the two new files) alongside the two new isolated points, so no
  suspicion of an unrelated regression. Measured drift for both new points landed well
  inside the existing `LIGHT_BOUNDS` — no bound widening needed, only the inline comment
  updated with the real numbers.
- **Browser/visual verification**: not performed as part of this pass — the user asked to
  test the rendered editor themselves (dev server left running at `localhost:3000/editor`
  for that purpose) rather than via automated browser tooling here. Shader-level
  correctness rests on: (1) the WGSL/GLSL curve being a direct transcription of the
  already-unit-tested TS reference (`highlightsShadowsL`, `color-math.test.ts`), matching
  every other composite control's existing WGSL/GLSL-mirrors-TS pattern in this codebase,
  and (2) `pnpm tsc --noEmit`/`pnpm lint`/`pnpm test` all passing, which does not catch
  WGSL/GLSL compile errors (shader source is a string, opaque to the TS compiler) — a real
  gap, consistent with this codebase's existing shader-testing limitations (no shader unit
  tests exist for any of the other composite controls either).

Verified: `go build ./...`, `go vet ./...`, `golangci-lint run ./...` (0 issues), `go test
./internal/processors/...` (pass, cached — no Go processor logic changed, only
`gendriftgolden/main.go`). TS side: `pnpm tsc --noEmit` (clean), `pnpm lint` (clean),
`pnpm test` (100/100, up from 89/89 — 11 new tests: 5 `highlightsShadowsL` unit tests, 4
new `applyAdjustLight` highlights/shadows tests, 2 new `drift.test.ts` Light points). Not
verified: actual WebGPU/WebGL2 shader compilation and visual output in a real browser —
deferred to the user's own manual check.
