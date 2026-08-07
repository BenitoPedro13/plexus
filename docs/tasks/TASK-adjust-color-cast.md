# TASK-adjust-color-cast — schema + Go processor for image.adjustColor.castStrength (D-27)

## Cenário actual

`apps/web/src/lib/recipe/schema.ts`'s `adjustColorParamsSchema` has exactly one field
(`saturation`); `workers/internal/processors/adjust_color.go`'s `AdjustColor` implements
only that field, via `img.Modulate(1, 1+saturation, 0)`. `cast` (Color composite's
white-balance slider) was left out of both, tracked as `D-27` in
`docs/90-deferred-register.md`: `TASK-vibrance-cast-grain-spike.md` found the grey-world
algorithm (`Stats`/`Average` for per-channel means, `Linear` with per-band coefficients to
equalize toward gray) fully buildable from govips primitives already used elsewhere in this
codebase — no fork needed, unlike `Grain` (`D-28`). D-27's own re-evaluation trigger reads:
"Next `image.adjustColor` follow-on task doc (schema + Go processor for `castStrength`),
same shape as `TASK-composite-processors-schema.md`/`-go.md` did for the original four
params."

Two things D-27 didn't verify were checked directly against this machine's real govips
v2.18.0 (module cache) and libvips 8.18.5 (locally installed, confirmed via `vips
--version`) before writing any processor code, via throwaway `go run` programs (same
verification method `TASK-composite-processors-go.md` used for the `blackPoint`
divide-by-zero clamp and `Recomb`'s band auto-expansion):

1. **`Stats()`+`GetPoint` on the resulting stats image is fragile, not a clean read.**
   `(*ImageRef).Stats()` mutates the image in place into a 1-band `BandFormatDouble` image
   (`n+1` rows: row 0 = whole-image stats, row `b` = band `b`'s stats; column 4 = mean).
   Reading a mean via `statsImg.GetPoint(4, band)` (the public API's only pixel-read method)
   requires passing `n` (expected element count) — `GetPoint`'s public wrapper hardcodes
   `n=3` (or 4 with alpha) based on the *caller* image's band count, not the 1-band stats
   image's actual band count. Empirically this returns `[mean, 0, 0]` (correct value in
   slot 0, zero-padded rest) against `testdata/images/gradient.jpg` — it "works" because
   libvips' C buffer happens to be zero-initialized beyond the real 1-band result, not
   because the API contract guarantees it. `ExtractBandToImage(band, 1)` + `.Average()` —
   already precedented in this codebase (`helpers_test.go`'s `imageAverage`, and
   `ExtractBandToImage` itself in `adjust_light.go`'s `applyHighlightsShadows`) — reads the
   same per-band mean with no such reliance on unstated buffer behavior. Verified both
   approaches agree exactly (whole-image average 136.833; per-band R/G/B 154/122.479/
   134.021) on `gradient.jpg`. This task uses `ExtractBandToImage`+`Average`, not `Stats`.

2. **`vips_linear`'s coefficient vector must have length 1 or exactly `Bands()` — confirmed
   via a real error, not docs.** Calling `img.Linear([]float64{r, g, b}, ...)` (3 elements)
   on a 4-band RGBA image (`vips bandjoin_const` used to synthesize one, since no alpha
   fixture exists in `testdata/`) fails with `"linear: vector must have 1 or 4 elements"`.
   Passing a 4th coefficient of `1.0` (alpha passthrough) succeeds and leaves the alpha band
   exactly unchanged (255 in, 255 out) while the color bands scale correctly. The processor
   must build a coefficient vector sized to `img.Bands()`, not hardcode length 3.

Grey-world math itself, verified against `gradient.jpg`: per-band means R=154,
G=122.479, B=134.021, target (mean of the three) = 136.833. `castStrength=0` is an exact
no-op (`a=[1,1,1]`, means unchanged). `castStrength=1` drives all three post-correction
means to 136.8333 (within 0.001, JPEG re-encode rounding). `castStrength=0.5` lands exactly
halfway between the two (linear interpolation, as intended).

## Mudanças planeadas

- `apps/web/src/lib/recipe/schema.ts`:
  - `adjustColorParamsSchema` gains `castStrength: z.number().min(0.0).max(1.0).default(0.0)`
    — optional/defaulted like `adjustLightParamsSchema`'s `highlights`/`shadows` (`D-25`/
    `V-7`'s precedent), so existing recipes authored with only `saturation` keep validating.
    Range is `0.0..1.0` per D-27's own note (a blend fraction: 0 = original, 1 = full
    grey-world correction), not `-1.0..1.0` like `saturation`.
  - Doc comment above `adjustColorParamsSchema` updated: `cast` moves from "deferred,
    unblocked but not yet schema'd, D-27" to implemented; `vibrance` stays the one deferred
    param (`D-29`, curve is a visual judgment call).
- `apps/web/src/lib/recipe/schema.test.ts`: range-boundary tests for `castStrength`
  (0.0/1.0 accepted, below 0/above 1 rejected, absent defaults to 0.0), following the
  existing `highlights`/`shadows` default-field test pattern.
- `workers/internal/processors/adjust_color.go`:
  - New `castMeanEpsilon = 1e-6` constant, same role as `adjust_light.go`'s
    `blackPointEpsilon` — floors a per-band mean before it's used as a divisor.
  - `AdjustColor` reads `castStrength` via `optionalFloatParamInRange(params,
    "castStrength", 0.0, 0.0, 1.0)` (default 0.0, matching `highlights`/`shadows`'s
    pattern in `adjust_light.go`).
  - Gated behind `if castStrength != 0` (same cost-avoidance pattern as `adjust_light.go`'s
    `if highlights != 0 || shadows != 0`, since the correction costs 3 extra
    `ExtractBandToImage`+`Average` passes):
    1. If `img.Bands() < 3`, error (`"castStrength requires at least 3 color bands, got
       %d"`) — grey-world correction has no meaning on a grayscale image; failing loudly
       beats silently ignoring the param.
    2. Per-band mean for bands 0/1/2 (R/G/B) via `ExtractBandToImage(b, 1)` + `.Average()`.
    3. `target := (meanR + meanG + meanB) / 3`.
    4. `scale(mean) := target / max(mean, castMeanEpsilon)` per band.
    5. Build `a := make([]float64, img.Bands())`: `a[0..2] = 1 + castStrength*(scale-1)`
       per band, `a[3:] = 1.0` (alpha/extra bands pass through unchanged, per the verified
       `vips_linear` length requirement above). `b := make([]float64, img.Bands())`, all
       zero.
    6. `img.Linear(a, b)`.
  - Applied before the existing `Modulate` saturation call (white-balance correction runs
    on the raw color, ahead of any saturation boost — matches how Apple Photos/Lightroom
    order white-balance ahead of vibrance/saturation in their own adjustment pipelines).
  - Doc comment updated: `castStrength` documented with its formula and range; `cast` moves
    out of the "Deferred" line, `vibrance`/`D-29` stays.
- `workers/internal/processors/adjust_color_test.go`: new cases following the existing
  `saturation` test shape — format/dimension preservation already covered by the existing
  test, so only new behavior needs new cases:
  - `castStrength=0` is a no-op (per-band means unchanged vs. a `saturation`-only run).
  - `castStrength=1` on a fixture with unequal per-band means converges those means to
    within a small tolerance of each other (grey-world corrected).
  - `castStrength` out of range (`-0.1`, `1.1`) is a validation error.
  - `castStrength` on a grayscale (< 3 band) input is an error, not a panic — needs a small
    grayscale fixture; reuse `writeUniformJPEG`-style helper or `vips` CLI to generate one
    into `t.TempDir()` if no grayscale fixture already exists in `testdata/images/`.

Not changed: the WebGPU/WebGL2 preview shaders (`webgpu-renderer.ts`/`webgl2-renderer.ts`)
and the editor UI (`ColorControl.tsx`) — no `castStrength` slider or preview-parity pass yet,
same two-phase split `V-7`→`D-25` used for `highlights`/`shadows` (Go-first, preview/UI as a
tracked follow-up). Recorded as new `D-30` in the deferred register, not silently dropped.

## Porquê

`D-27` names this as the explicit next step and it's fully unblocked — no fork, no
undecided formula, only the blend-amount UX call D-27 itself already resolved (`0.0..1.0`
lerp). Verifying `Stats()`/`GetPoint`'s fragility and `vips_linear`'s exact length
requirement against a real govips/libvips build (not assumed from the register's summary)
matters here specifically: D-27 said "the math is exact and textbook," which is true of the
grey-world formula itself, but *how* to read the per-band means and *how* to shape the
coefficient vector for images with an alpha band were unverified implementation details a
naive read of the register entry could get wrong (an alpha-corrupting `Linear` call, or a
`GetPoint` read that happens to work today but relies on undocumented C-level zero-padding).
Doing schema + Go only (not shaders/UI) matches the exact two-phase precedent `V-7`/`D-25`
already established for `highlights`/`shadows` on this same processor family — the preview
renderers and editor UI are a separate, larger unit of work (new shader math + a new slider)
that deserves its own reviewed task rather than being folded in here.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `docs/tasks/TASK-adjust-color-cast.md` | new | this document |
| `apps/web/src/lib/recipe/schema.ts` | edit | add `castStrength` to `adjustColorParamsSchema`, update doc comment |
| `apps/web/src/lib/recipe/schema.test.ts` | edit | range/default tests for `castStrength` |
| `workers/internal/processors/adjust_color.go` | edit | implement grey-world `castStrength`, update doc comment |
| `workers/internal/processors/adjust_color_test.go` | edit | no-op/convergence/range/grayscale-input tests |
| `docs/90-deferred-register.md` | edit | resolve `D-27`; add `D-30` (preview shader + editor UI parity for `castStrength`, same shape as `D-25`) |
