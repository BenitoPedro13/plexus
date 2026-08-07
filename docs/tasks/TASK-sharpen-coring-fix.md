# TASK-sharpen-coring-fix — add libvips' flat/jaggy coring to the Sharpen preview (Phase 2)

## Cenário actual

`image.sharpen`'s live preview (`apps/web/src/lib/preview/color-math.ts`'s `applyUnsharpMask`,
transcribed into `webgpu-renderer.ts`'s `UNSHARP_WGSL` and `webgl2-renderer.ts`'s
`UNSHARP_FRAGMENT_SHADER_SOURCE`) implements unsharp masking as a plain, unconditional linear
response:

```
sharpenedL = origLab.L + m2 * (origLab.L - blurredLab.L)     // m2 = 3 * intensity
```

`workers/internal/processors/sharpen.go` calls govips' `img.Sharpen(0.5, 2, 3*intensity)` —
`(sigma, x1, m2)`. Confirmed against govips' own source
(`vips/image_pixel.go`, `github.com/davidbyttow/govips/v2@v2.18.0`): `Sharpen`'s
`SharpenOptions` only sets `Sigma`, `X1`, `M2` — `M1`, `Y2`, `Y3` are left nil, so libvips'
own C defaults apply: `m1=0` (slope for flat areas), `y2=10` (max brightening, L\* units),
`y3=20` (max darkening, L\* units), per libvips' own docs
(`https://www.libvips.org/API/8.17/method.Image.sharpen.html`, already the source for the
`sigma=0.5, x1=2` values the mapping doc records).

libvips' real algorithm is piecewise, not the single-slope line the preview implements: for
each pixel, `diff = origL - blurredL`; if `|diff| <= x1` (flat area — noise, smooth
gradients) the response uses slope `m1=0`, i.e. **no sharpening at all**; only outside that
±2 L\* band (`|diff| > x1`, a real edge) does slope `m2` apply. The result is then clamped
to `[-y3, y2]` = `[-20, 10]` L\* units. The preview's plain-linear version has neither the
coring gate nor the clamp, so it amplifies *every* difference from the blur — including
compression noise in flat regions, which isn't a real edge and should get zero response.

**Real-world symptom** (`docs/90-deferred-register.md` `V-2`, observed 2026-08-07 on
`/editor` against a real JPEG-noisy photo): with Sharpen intensity near 1.0, stacking
Light + Saturation on top produces visible black/white speckling in flat dark regions. Root
cause: the missing coring threshold means ordinary compression noise (small, high-frequency
`origL - blurredL` differences) gets amplified by `m2` as if it were a real edge; Light's
exposure gain and Color's Lab round-trip add just enough extra per-pixel variance beforehand
to make the amplified noise visible. `V-2` already named the fix (add the coring threshold,
matching libvips' `x1` param already fixed at 2) as the trigger for this exact task.

The recipe-fidelity drift harness (`apps/web/src/lib/preview/drift.test.ts`) already flags
Sharpen as the one composite control with real, documented divergence from Go
(`SHARPEN_BOUNDS = { mae: 1.0, max: 110, meanDeltaE: 0.3 }`, deliberately loose on `max`) —
this task should tighten that bound once the coring fix brings the TS reference closer to
libvips' actual behavior, not leave the old loose bound in place unexamined.

## Mudanças planeadas

- **`apps/web/src/lib/preview/color-math.ts`** — `applyUnsharpMask`: replace the
  unconditional `m2 * diff` response with libvips' piecewise version: `x1=2`, `y2=10`,
  `y3=20`, `m1=0` (all L\* units, matching `rgbToLab`'s 0–100 `L` scale directly — no unit
  conversion needed for the `'lab-l'` path). `slope = |diff| <= x1 ? m1 : m2`; `y =
  clamp(slope * diff, -y3, y2)`; `sharpenedL = origLab.L + y`. For the `'rgb'` fallback path
  (0..1 scale, not the production default and not what `V-10` confirmed libvips actually
  does), apply the same three constants scaled by `1/100` for dimensional consistency with
  the 0..1 range, rather than leaving that branch's response shape inconsistent with the
  now-fixed `'lab-l'` branch. Comment updated to cite the govips `SharpenOptions` source
  confirming `m1`/`y2`/`y3` take libvips' defaults, not some govips-specific override.
- **`apps/web/src/lib/preview/webgpu-renderer.ts`** — `UNSHARP_WGSL`: same piecewise
  logic in WGSL (`abs()`, a ternary via `select()`, `clamp()`), operating on `origLab.x`/
  `blurredLab.x` (the L channel) exactly as the JS reference does.
- **`apps/web/src/lib/preview/webgl2-renderer.ts`** — `UNSHARP_FRAGMENT_SHADER_SOURCE`: same
  piecewise logic in GLSL (`abs()`, `mix()` or a branch, `clamp()`).
- **`apps/web/src/lib/preview/color-math.test.ts`** (or wherever `applyUnsharpMask` is
  already unit-tested) — add cases: a small diff (`|diff| <= 2`) must return the original
  pixel unchanged regardless of `intensity` (the coring gate), and a large diff must still
  respond with the existing `m2` slope, clamped at the `y2`/`y3` bounds.
- **`apps/web/src/lib/preview/drift.test.ts`** — re-run against the existing
  `testdata/drift/` fixtures/goldens (no fixture regeneration needed — the Go side is
  unchanged) and tighten `SHARPEN_BOUNDS` to the new observed worst-case
  mae/max/meanDeltaE, following the file's own established convention (~1.3–1.7× above the
  actual worst point, not the old placeholder-loose `max: 110`).
- **`docs/90-deferred-register.md`** — `V-2`: append the resolution (coring fix landed,
  new drift bounds, date) to the existing entry rather than opening a new one — this task
  is exactly the trigger `V-2` already recorded.

No Go changes — `workers/internal/processors/sharpen.go` already calls the real
`img.Sharpen`, which has always had this behavior; only the TS/WGSL/GLSL approximation was
wrong.

## Porquê

This is a real, observed user-facing bug (visible speckling on real photos), not a
speculative gap — `V-2` already scoped the fix and the trigger to verify against. The
preview's job is to approximate what Go will actually render close enough that "what you
see is what you get" holds (CLAUDE.md's non-negotiable: "an export that doesn't match the
preview the user approved"); a plain unconditional linear response was always going to
diverge on real (noisy) photos even though it looked fine on the smooth synthetic drift
fixture, which is exactly why the drift harness's synthetic checkerboard didn't already
catch this. Confirmed via govips' own source that `m1=0`/`y2=10`/`y3=20` are libvips'
real defaults, not an invented value — consistent with CLAUDE.md §0's "never invent an
API/protocol/codec behaviour" rule.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/color-math.ts` | edit | `applyUnsharpMask`: piecewise flat/jaggy coring + y2/y3 clamp, both `'lab-l'` and `'rgb'` branches |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | `UNSHARP_WGSL`: same piecewise logic in WGSL |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | `UNSHARP_FRAGMENT_SHADER_SOURCE`: same piecewise logic in GLSL |
| `apps/web/src/lib/preview/color-math.test.ts` | edit | add coring-gate and clamp unit test cases for `applyUnsharpMask` |
| `apps/web/src/lib/preview/drift.test.ts` | edit | tighten `SHARPEN_BOUNDS` to new observed worst-case drift |
| `docs/90-deferred-register.md` | edit | resolve `V-2`'s sharpen-coring trigger with date and outcome |
