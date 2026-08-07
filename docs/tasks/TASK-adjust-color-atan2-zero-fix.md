# TASK-adjust-color-atan2-zero-fix — guard atan2(0,0) in the Color composite preview (Phase 2)

## Cenário actual

Real-photo testing on `/editor` (2026-08-07, user report) showed solid black corruption
patches in the live preview, concentrated in the hazy/bright sky region of a real JPEG, at
`Saturation=1.0` with `Sharpen=0.00` (ruling out the just-fixed `TASK-sharpen-coring-fix.md`
bug) — and visibly worse when `Light=1.00` was also applied. Two screenshots confirmed
Saturation as the reproducing control; the corruption shape wasn't random noise but tracked
coherently with the sky/highlight region.

`applyAdjustColor` (`apps/web/src/lib/preview/color-math.ts`) and its WGSL/GLSL
transcriptions (`ADJUST_COLOR_WGSL` in `webgpu-renderer.ts`, `ADJUST_COLOR_FRAGMENT_SHADER_SOURCE`
in `webgl2-renderer.ts`) all compute `hue = atan2(lab.b, lab.a)` unconditionally, for every
pixel, before scaling chroma.

An exhaustive Node.js sweep of the entire RGB cube (0..1 in 0.04 steps, ~17.5k samples) through
the TS reference at `saturation=1.0` found **zero** cases where a non-black input produced a
near-black output — ruling out the per-pixel formula itself as buggy in JS. The reason:
`Math.atan2(0, 0)` is well-defined in JavaScript (`0`, per ECMA-262).

**WGSL and GLSL do not give that guarantee.** Confirmed against both specs directly:

- WGSL (`w3.org/TR/WGSL/`, §17.5.8 `atan2`): defined as `atan(e1/e2)` with quadrant
  correction — for `e1=e2=0`, that's `atan(0/0)` = `atan(NaN)` = `NaN`, a direct consequence
  of the spec's own definition, not an edge case needing empirical GPU testing.
- GLSL ES (Khronos reference pages, corroborated via `docs.gl/sl4/atan`): "Results are
  undefined if x is zero" (the full spec text, well-established GLSL convention: undefined
  when both `x` and `y` are 0) — driver-dependent, may be `NaN` or other garbage.

A pixel hits `lab.a == 0 && lab.b == 0` exactly whenever it's perfectly achromatic (neutral
gray/white) — routine after an 8-bit `rgba8unorm` intermediate-texture round-trip quantizes
a near-gray sky pixel to an exact `r == g == b` value. `NaN` then propagates: `cos(NaN)`/
`sin(NaN)` → `NaN` → the boosted Lab `a`/`b` → the RGB conversion matrix → clamped to black
once written to the 8-bit output texture (the typical NaN→0 behavior on write-to-unorm).
This explains every observed symptom: black specifically in near-achromatic (sky/highlight)
regions; worse with `Light` cranked up (exposure-boosting pushes *more* pixels toward pure
white, i.e. toward the achromatic condition); and invisible to the JS-only drift/unit tests
(JS's `atan2(0,0)` never hits the undefined case the shaders do).

## Mudanças planeadas

- **`apps/web/src/lib/preview/color-math.ts`** — `applyAdjustColor`: guard the hue
  computation behind a `chroma > CHROMA_EPSILON` check (`CHROMA_EPSILON = 1e-4`, Lab units).
  Below threshold, skip `atan2`/`cos`/`sin` entirely and use `a = 0, b = 0` directly — the
  boosted chroma is negligible at that point regardless of which hue would've been chosen,
  so this changes no visible behavior for any real (non-exactly-achromatic) pixel; it only
  removes the `atan2(0,0)` call path. Matches JS's already-defined `atan2(0,0) = 0` output,
  so no existing test assertions change.
- **`apps/web/src/lib/preview/webgpu-renderer.ts`** — `ADJUST_COLOR_WGSL`: same guard,
  using a real scalar `if` (not `select()`, to avoid relying on `select()`'s branch-masking
  being NaN-clean on every driver) — only call `atan2` when `chroma > CHROMA_EPSILON`.
- **`apps/web/src/lib/preview/webgl2-renderer.ts`** — `ADJUST_COLOR_FRAGMENT_SHADER_SOURCE`:
  same guard in GLSL.
- **`apps/web/src/lib/preview/color-math.test.ts`** — add a case: a perfectly achromatic
  pixel (`r === g === b`) at `saturation > 0` must return a finite, non-NaN, non-black
  result equal to the (unboosted) input — this is the exact condition that was undefined in
  WGSL/GLSL, and pinning it in the JS reference documents the invariant even though JS
  itself never hit the bug.
- **`docs/90-deferred-register.md`** — new resolved entry (not a `V-xx`/`D-xx` — this was
  found and fixed within one task, not deferred at any point) documenting the root cause,
  the spec citations, and the fix, cross-referenced from the existing `V-2`/`V-11` entries
  since it's adjacent territory (Color composite fidelity) but a distinct correctness bug,
  not a fidelity-drift question.

No Go changes — `workers/internal/processors/adjust_color.go` calls govips' `Modulate`,
which has no such issue (it's not implemented via a naive per-pixel `atan2` in application
code); this bug is specific to the hand-written WGSL/GLSL preview approximation.

## Porquê

This is a confirmed, spec-verified correctness bug, not a fidelity/approximation gap —
`atan2(0,0)` being undefined in both shading languages is documented behavior, not
speculation, so this doesn't fall under CLAUDE.md §0's "never invent behavior" concern; it's
the opposite case, where *not* guarding was already relying on unspecified behavior. It's a
real, user-blocking bug (visible black corruption on ordinary real photos, not a synthetic
edge case) that the existing recipe-fidelity drift harness structurally cannot catch, since
that harness runs the same JS reference math being validated, and JS's `atan2(0,0)` was
never the problem — only the GPU paths were. Worth recording as its own lesson: V-2's
synthetic drift fixture and this repo's Vitest suite both run in Node/jsdom, so any future
bug that's specific to WGSL/GLSL floating-point or undefined-behavior semantics (as opposed
to the shared per-pixel formula) needs either a real browser/GPU check or, as here,
cross-referencing the target language's own spec — not just testing the TS mirror harder.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/color-math.ts` | edit | `applyAdjustColor`: guard hue/atan2 behind `chroma > CHROMA_EPSILON` |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | `ADJUST_COLOR_WGSL`: same guard in WGSL |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | `ADJUST_COLOR_FRAGMENT_SHADER_SOURCE`: same guard in GLSL |
| `apps/web/src/lib/preview/color-math.test.ts` | edit | add achromatic-pixel regression case for `applyAdjustColor` |
| `docs/90-deferred-register.md` | edit | new resolved entry documenting the atan2(0,0) root cause and fix |
