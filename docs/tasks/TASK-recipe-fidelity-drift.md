# TASK-recipe-fidelity-drift

## Cenário actual (Current scenario)

The four composite processors landed across three prior task docs (`D-19` in
`docs/90-deferred-register.md`):

- Go ground truth: `workers/internal/processors/adjust_light.go`,
  `adjust_color.go`, `black_and_white.go`, `sharpen.go` — each calls real
  govips ops (`Linear1`, `Modulate`, `Recomb`, `Sharpen`).
- Live-preview approximation: `apps/web/src/lib/preview/color-math.ts` — a
  pure-TS reference implementation of the same math, hand-transcribed from
  the Go formulas, that both `webgpu-renderer.ts` (WGSL) and
  `webgl2-renderer.ts` (GLSL) are hand-transcribed *from* in turn.

**Nobody has ever measured how far apart these two renders actually are.**
`color-math.ts`'s own file comment admits govips's per-op 8-bit clamping
behavior is unverified; every function was written to be *directionally*
correct (unit-tested for "brighter", "more saturated", "grayer") but never
compared pixel-for-pixel against a real govips render. This is exactly the
gap CLAUDE.md §0 Tests calls out by name: *"drift between the WebGPU/WebGL
preview approximation and the Go ground-truth render gets a numeric bound
per composite control, and a test that enforces it"* — and it's `V-2` in the
deferred register, open since Phase 2 started.

Two blockers on `V-2` were resolved researching this task doc (primary
sources checked, no code changes needed — see `docs/90-deferred-register.md`
for the updated entries):

- **V-10** (sharpen colourspace): confirmed directly from
  `libvips/libvips/convolution/sharpen.c` (`master`,
  `vips_colourspace(in, &t[0], VIPS_INTERPRETATION_LABS, ...)`, band-0
  extract, sharpen, recombine, convert back) — `vips_sharpen` operates on
  the L channel of LABS only. `color-math.ts`'s `applyUnsharpMask` already
  defaults to `'lab-l'`. No change needed.
- **V-11** (Lab white point): confirmed directly from
  `libvips/libvips/colour/XYZ2Lab.c` (`XYZ2Lab.X0/Y0/Z0 = VIPS_D65_X0/Y0/Z0`)
  — govips's `Modulate()` round-trips through `ToColorSpace(LCH)`, which
  uses this same conversion, so the D65 white point `color-math.ts` already
  assumes is correct. No change needed. (Gamut-clamping strategy on the
  round trip back to sRGB is still not separately documented anywhere
  primary-sourced; not blocking — any clamp discrepancy will show up
  directly as measured drift, which is exactly what this task quantifies.)

With both blockers cleared, nothing stands between here and actually
measuring `V-2`.

There is no existing fixture suited to this: `workers/testdata/images/`
only has `gradient.jpg`/`gradient.png` (flat gradients, already flagged by
`V-9` as unable to exercise sharpen's edge response, and equally unable to
exercise `adjustColor`'s hue response since a gradient has no hue variety).
There is also no mechanism today for a Go test and a TS (Vitest) test to
compare pixels against each other — they're different processes, different
languages, no shared fixture format.

## Mudanças planeadas (Planned changes)

**New shared fixture directory: `testdata/drift/`** (repo root — not inside
`workers/` or `apps/web/`, since both toolchains need it and neither owns
the other; no `packages/` yet per `D-1`). Contains only generated,
committed binary/PNG fixtures — no code.

1. **`workers/cmd/gendriftfixture/main.go`** (new) — a one-shot generator,
   run manually (`go run ./cmd/gendriftfixture`), not part of `go test` or
   CI. Synthesizes a single 128×128 source image via Go's stdlib
   `image`/`image/draw`/`image/png` (not govips — this is synthetic test
   data, not a media-processing operation, so stdlib is the right tool per
   CLAUDE.md §2.2) with three regions so every composite control has
   something real to respond to:
   - top third: smooth luminance gradient, low saturation (exercises
     `adjustLight`, the `intensity`/`tone` blend of `blackAndWhite`)
   - middle third: six solid hue patches spanning the color wheel at fixed
     L/C (exercises `adjustColor`'s saturation scaling, `blackAndWhite`'s
     `neutrals` channel-mix skew)
   - bottom third: a fine checkerboard, alternating high-contrast pixels
     (exercises `sharpen`'s edge response — the concrete gap `V-9` flagged)

   Writes `testdata/drift/source.png`.

2. **`workers/cmd/gendriftgolden/main.go`** (new) — a second one-shot
   generator (`go run ./cmd/gendriftgolden`), also manual/not-CI. For each
   of a small set of representative param combinations per composite
   control (2–3 points per control spanning mild → strong, not an
   exhaustive param sweep — see table below), calls the **real** exported
   processor function (`processors.AdjustLight`/`AdjustColor`/
   `BlackAndWhite`/`Sharpen`, unmodified, same code path the worker runs in
   production) against `source.png`, then reads every pixel of both the
   original source and each result via govips's existing `img.GetPoint(x,
   y)` (already used in `helpers_test.go`) and writes a raw RGBA8 dump:
   a tiny custom format, 8-byte header (`width uint32LE`, `height
   uint32LE`) followed by `width*height*4` bytes, row-major, one byte per
   channel per pixel, values 0–255. Chosen over re-shipping a PNG decoder
   into the TS toolchain (no such dependency exists there today — see
   `package.json`) specifically so the TS side reads the *exact* pixels
   govips itself decoded, isolating "shader math drift" from "which
   PNG/JPEG decoder" noise.

   Writes `testdata/drift/source.rgba` and one
   `testdata/drift/golden/<control>-<point>.rgba` per param combination
   (e.g. `light-mild.rgba`, `light-strong.rgba`, `color-sat-0.5.rgba`, …).

   | Control | Points (param values) |
   |---|---|
   | Light (`image.adjustLight`) | mild: `exposure=0.5, brightness=0.1, contrast=0.2, blackPoint=0.05`; strong: `exposure=-0.5, brightness=-0.2, contrast=0.3, blackPoint=0.1` (tuned down from an initial `-1/-0.3/0.4/0.15` that black-clipped every pixel in both TS and Go, making that point's drift trivially 0 — not a useful measurement) |
   | Color (`image.adjustColor`) | `saturation=0.5`; `saturation=-0.5`; `saturation=1.0` |
   | B&W (`image.blackAndWhite`) | full: `intensity=1, neutrals=0, tone=0`; skewed: `intensity=0.6, neutrals=0.5, tone=-0.3` |
   | Sharpen (`image.sharpen`) | `intensity=0.3`; `intensity=1.0` |

3. **`apps/web/src/lib/preview/drift.test.ts`** (new Vitest test). For each
   golden point above:
   - reads `testdata/drift/source.rgba` and the matching
     `testdata/drift/golden/*.rgba` with plain `node:fs` (fixed 8-byte
     header, no parsing library needed)
   - runs `color-math.ts`'s real exported reference function
     (`applyAdjustLight`/`applyAdjustColor`/`applyBlackAndWhite`) per pixel
     over the source raster to produce the TS-side raster. For the sharpen
     case specifically, also runs a small **test-local** separable
     convolution using the already-exported `gaussianKernel1D`, then
     `applyUnsharpMask` — mirroring exactly what `webgpu-renderer.ts`/
     `webgl2-renderer.ts` do as two passes, since `color-math.ts`
     deliberately only exports the per-pixel half (see its own comment on
     `applyUnsharpMask`). This convolution helper lives in the test file,
     not in `color-math.ts` — it exists to make the test a fair comparison,
     not as reusable renderer code.
   - computes, per control-point: mean absolute error (MAE) and max
     absolute error per RGB channel (0–255 scale), plus mean CIE76 ΔE
     (reusing `rgbToLab`, already in `color-math.ts` — needs exporting,
     currently private) for the two controls whose math routes through Lab
     (`adjustColor`, `sharpen` in its default `'lab-l'` mode) since ΔE is
     the perceptually meaningful metric there, not raw RGB MAE.
   - **first run: log the numbers, assert nothing.** Bounds get written
     into the test only after seeing real measured drift — CLAUDE.md §0
     bans "close enough" and demands a *measured* bound, so the bound
     can't be decided before the measurement exists.
   - **second pass (same task, after seeing the numbers):** hard-code a
     bound per control just above the measured worst-case point, with the
     measured number in an inline comment (matching how `V-9`/`V-10` etc.
     already document reasoning), and turn the log into a real assertion —
     this becomes the permanent regression guard CLAUDE.md §0 requires.

4. **`apps/web/src/lib/preview/color-math.ts`** (edit) — export `rgbToLab`
   (currently module-private) so the drift test can compute ΔE without
   duplicating the Lab conversion. No behavioral change.

5. **`docs/90-deferred-register.md`** (edit) — `V-10` and `V-11` move to
   Resolved now (research already done, see Current Scenario above,
   independent of the rest of this task landing). `V-2` moves to Resolved
   once the measured bounds are committed, with the actual numbers and
   which controls/points were measured. `V-9` (no sharpen fixture with real
   edges) also resolves — `testdata/drift/source.png`'s checkerboard region
   satisfies its trigger, though it's a shared drift fixture rather than a
   `workers/testdata/images/` unit-test fixture; note that explicitly so a
   future reader doesn't expect a second, separate fixture.

**Not in scope** (explicitly, to keep this task from sprawling):
`image.resize`'s drift (`V-6`) — different mechanism (geometry, not
per-pixel color math), its own follow-up. Blend-ratio slider-to-parameter
tuning and the real editor UI (`D-6`) — both still blocked behind this
task per `D-19`'s own ordering, not done here.

## Porquê (Why)

`V-2` is the spec's own "Recipe fidelity" success metric (CLAUDE.md §0
Tests) and has been open since Phase 2 preview work started — every
composite control has shipped without ever checking its live-preview
approximation against reality. The risk this closes is concrete and named
in CLAUDE.md's own "Things that must not break": *"the export doesn't match
the preview the user approved"* is one of the two governing failure modes
the whole test strategy exists to catch, and right now it's simply
unmeasured, not passing.

Doing V-10/V-11 first (rather than starting the harness with an unresolved
`'lab-l'` guess) meant the harness gets built once, correctly, instead of
built now and revisited later if the guess had been wrong — both resolved
in this same pass via primary source (libvips' own C source, not
recollection), so there was no reason to defer them further.

The raw-RGBA8-dump approach (rather than decoding PNGs on the TS side) was
chosen specifically to avoid adding a new dependency (`apps/web`'s
`package.json` has no image-decode library today) and, more importantly, to
avoid a second source of pixel disagreement (PNG decoder differences)
polluting a measurement that's supposed to isolate *shader math* drift.
Committing raw dumps as golden fixtures is unusual compared to the repo's
existing golden-fixture pattern (`workers/testdata/images/`, measured
*properties* not byte-equality per CLAUDE.md §0) — but that pattern is for
non-deterministic encoders; this is the opposite case, comparing two
independent *computations* of the same deterministic math, where exact
per-pixel values are the entire point.

Deferring bound selection until after the harness runs once (rather than
picking round numbers like "5%" up front) is the direct reading of CLAUDE.md
§0's "measured, not eyeballed" — a bound chosen before there's a
measurement to compare it to is exactly the "close enough" the spec's
success metrics are written to rule out.

## Ficheiros afectados (Affected files)

| File | Change type | Notes |
|------|-------------|-------|
| `workers/cmd/gendriftfixture/main.go` | new | synthesizes `testdata/drift/source.png` (gradient + hue patches + checkerboard) via stdlib `image/png`, not govips |
| `workers/cmd/gendriftgolden/main.go` | new | runs the real Go processors against `source.png`, dumps raw RGBA8 goldens via `img.GetPoint` |
| `testdata/drift/source.png` | new | committed, human-viewable fixture |
| `testdata/drift/source.rgba` | new | committed, raw RGBA8 dump of the exact pixels govips decoded |
| `testdata/drift/golden/*.rgba` | new | committed, one per control/point (~9 files per the table above) |
| `apps/web/src/lib/preview/drift.test.ts` | new | reads fixtures, runs `color-math.ts` reference math (+ test-local convolution for sharpen), computes MAE/max/ΔE, asserts measured bounds |
| `apps/web/src/lib/preview/color-math.ts` | edit | export `rgbToLab` (no behavior change) |
| `docs/90-deferred-register.md` | edit | resolve `V-9`, `V-10`, `V-11` now; resolve `V-2` once bounds are measured and committed |
