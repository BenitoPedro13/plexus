# TASK-black-and-white-grain — govips-fork wrapper + schema + Go processor for image.blackAndWhite.grain (D-28)

## Cenário actual

`docs/90-deferred-register.md`'s `D-28` records that **Grain** (`image.blackAndWhite`'s
fourth P0 param, per `TASK-composite-slider-mapping.md`'s mapping table) needs a small
`workers/internal/govips-fork/vips/` extension before any Go processor work can start:
`vips_gaussnoise` ("make a gaussnoise image") exists at govips' C-binding layer
(`vips/generated.go:1777`, `vipsGenGaussnoise(width, height int, opts *GaussnoiseOptions)
(*C.VipsImage, error)`) but has no public `ImageRef`-returning wrapper anywhere in
`github.com/davidbyttow/govips/v2@v2.18.0` — confirmed by grepping every `vips/image_*.go`
file (`TASK-vibrance-cast-grain-spike.md`, resolved `V-8`). Same root cause `D-24` already
hit and solved for `Tonelut` (`workers/internal/govips-fork/vips/tonelut.go`): a
from-scratch generator with no input `*ImageRef` to attach a method to, and
`newImageRef`/`ImageRef.image` both unexported, so no wrapper outside the `vips` package can
construct the result either.

Today: `apps/web/src/lib/recipe/schema.ts`'s `blackAndWhiteParamsSchema` has exactly three
fields (`intensity`, `neutrals`, `tone`); `workers/internal/processors/black_and_white.go`'s
`BlackAndWhite` implements only those three. `grain` is explicitly called out as deferred in
both files' doc comments, pointing at `D-28`.

`D-29` (adjacent, not the same item) separately notes that Grain's *exact* blend
mode/intensity-to-sigma mapping is an aesthetic judgment call with no primary source, same
category as Vibrance's curve — deliberately not invented in the spike task. This task does
not resolve that ambiguity by researching harder; it resolves it the same way this codebase
already resolved the equivalent ambiguity for B&W's own `neutrals` skew
(`black_and_white.go`'s `grayscaleMatrix`, whose doc comment says outright: "a first-pass
choice, not empirically tuned against real photos"). A slider needs a real value to be worth
anything in the editor, and `D-29`'s own re-evaluation trigger ("the first time a real photo
is dragged through `/editor`") can't fire until a Grain control exists to drag. This task
ships a documented, honest first-pass mapping and updates `D-29` to reflect "wired, needs
tuning" rather than leaving Grain unimplemented indefinitely.

## Mudanças planeadas

### Verification performed before writing this doc (not assumed)

Ran directly against this machine's real `vips` CLI (libvips 8.18.5, matching the
`govips`/libvips version already used by every other verified task in this register):

1. `vips_gaussnoise`'s **default `mean` is 128, not 0** — confirmed via `vips gaussnoise
   --help` and by generating a real noise image and reading its `avg` (127.68 for
   `--mean 128`). Compositing that directly onto a real image via `vips composite2 ... add`
   shifted the base image's average from 136.83 to 237.63 (JPEG-clamped near white) — using
   the *default* mean would silently wreck the image, not add subtle grain. `mean` must be
   explicitly passed as `0` for the noise to be zero-centered (verified: `avg` output then
   moves only slightly, 136.83 → 135.80, consistent with an unbiased additive perturbation).
2. `vips composite2 ... add` (govips' `(*ImageRef).Composite` + `BlendModeAdd`, the
   primitive `TASK-vibrance-cast-grain-spike.md` originally pointed at) **silently
   synthesizes a 4th alpha band** on 3-band inputs that have none (confirmed: a 3-band JPEG
   base composited with a 1-band noise overlay in `add` mode produced a 4-band `.v` output).
   That's real Porter-Duff behavior (compositing needs alpha to be meaningful), not a bug,
   but it's an unwanted side effect here — grain isn't a layer compositing operation, and
   the extra band would need stripping/flattening before export, adding a step nowhere else
   in this codebase's composite processors needs.
3. Plain arithmetic **`vips add` (govips' `(*ImageRef).Add`, already used by
   `black_and_white.go`'s own `intensity` blend) does not have that problem**: adding a
   1-band image to a 3-band image produces a 3-band output (band count follows the base),
   confirmed by extracting each output band and diffing against the original per-band
   values — the same raw noise value lands identically in all three color bands (max
   diff 0.000015, float rounding only), i.e. a clean achromatic broadcast, no extra band.
4. **`Add`'s broadcast is not alpha-safe** — confirmed by running it against a synthetic
   4-band (RGBA) fixture (`vips bandjoin_const gradient.jpg 200`): the 1-band noise gets
   added to the alpha band too (max diff 36.95), which would corrupt transparency. Fix,
   verified working: build the noise image as 3 bands (via `BandJoin(noise, noise, noise)`
   — joining the same `*ImageRef` with itself three times, the same technique
   `ToColorSpace`-free "fake RGB from 1-band" broadcasts use) and, only if the source has
   alpha, append one more **constant-zero** band (`BandJoinConst([]float64{0})`) so the
   noise image's band count matches the source exactly and the alpha band gets `+0`
   (confirmed: alpha diff after `Add` is exactly 0 with this construction, vs. 36.95
   without it). Same discipline `adjust_color.go`'s `applyCast` already established for
   `vips_linear`'s per-band coefficient vector (alpha gets an identity/no-op entry, never a
   correction it wasn't asked for).
5. **Noise image dimensions must exactly match the source** (`img.Width()`/`img.Height()`)
   — confirmed a mismatched-size `Add` (400x300 noise onto a 64x48 base) does not error,
   it silently outputs at the *larger* size instead, which would corrupt geometry rather
   than fail loudly. `NewGaussnoiseImage` must always be called with the source's own
   dimensions, never a param default.
6. **Default `seed` is not reproducible.** Omitting `--seed` (its documented default value
   is `0`, but that's the *declared* CLI default text, not what omitting the flag does)
   produces a different noise image on every call (two back-to-back generations differed,
   max diff 32.3); passing an explicit fixed seed (any int, including literal `0`) makes it
   fully deterministic (two back-to-back generations with the same seed differed by exactly
   0.0). The processor must always pass an explicit seed — non-reproducible pixel output
   from the same recipe on the same input would break golden-fixture testing and (later)
   the recipe-fidelity drift metric CLAUDE.md §0 requires.

### `workers/internal/govips-fork/vips/gaussnoise.go` (new)

Mirrors `tonelut.go`'s shape exactly (same doc-comment structure explaining *why* this
lives in the fork, same one-function-wrapping-one-generator pattern):

```go
package vips

// NewGaussnoiseImage generates a single-band Gaussian-noise image of the
// given size ... [same "not exported by govips v2.18.0, D-28" explanation
// tonelut.go gives for the equivalent Tonelut gap]
func NewGaussnoiseImage(width, height int, opts *GaussnoiseOptions) (*ImageRef, error) {
	out, err := vipsGenGaussnoise(width, height, opts)
	if err != nil {
		return nil, err
	}
	return newImageRef(out, ImageTypeUnknown, ImageTypeUnknown, nil), nil
}
```

### `workers/internal/processors/black_and_white.go` (edit)

- New constants, same role/placement as `adjust_color.go`'s `castMeanEpsilon`:
  - `grainMaxSigma = 25.0` — first-pass upper bound for `vips_gaussnoise`'s `sigma` at
    `grain=1.0` (govips/libvips' own declared default is 30 when the arg is omitted
    entirely; 25 is a deliberately gentler starting point, not a researched optimum).
    **Explicitly a `D-29`-tracked judgment call** — doc comment says so outright, same as
    `grayscaleMatrix`'s.
  - `grainNoiseSeed = 42` — fixed, arbitrary, documented. Not an aesthetic choice: any
    fixed value gives deterministic output, which is what reproducibility requires; the
    specific number doesn't matter.
- `BlackAndWhite` reads `grain` via `optionalFloatParamInRange(params, "grain", 0.0, 0.0,
  1.0)` — optional/defaulted like `adjust_color.go`'s `castStrength` and
  `adjust_light.go`'s `highlights`/`shadows`, so existing recipes/tests that only pass
  `intensity`/`neutrals`/`tone` keep validating unchanged.
- Applied **last**, after the existing intensity blend (grain is a property of the final
  print, not an input layer to blend) — gated behind `if grain != 0` (same cost-avoidance
  pattern as the other two composite processors, since it costs a noise-image generation
  and an extra full-image pass):
  1. `sigma := grain * grainMaxSigma`.
  2. `noise, err := vips.NewGaussnoiseImage(img.Width(), img.Height(),
     &vips.GaussnoiseOptions{Sigma: &sigma, Mean: &zero, Seed: &grainNoiseSeed})` (`zero :=
     0.0` local, mean must be explicit per verification point 1 above).
  3. `defer noise.Close()`.
  4. Replicate to 3 bands: `if err := noise.BandJoin(noise, noise); err != nil { ... }`
     (verification point 3/4 above — joining the same `*ImageRef` with itself, giving 3
     identical bands).
  5. If `img.HasAlpha()`: `if err := noise.BandJoinConst([]float64{0}); err != nil { ...
     }` — matches band count exactly, alpha gets `+0`.
  6. `if err := img.Add(noise); err != nil { ... }`.
- Doc comment updated: `grain` moves from "Deferred ... D-28" to documented with its
  formula/range; doc comment's existing "Deferred: grain" paragraph is removed (nothing
  left in this processor's P0 set is deferred).

### `workers/internal/processors/black_and_white_test.go` (edit)

New cases, following the existing `tone` test's shape (directional assertion on the
encoded-and-reloaded output, not exact-value prediction through lossy JPEG):

- `grain=0` is a no-op (byte-identical output to a run without the `grain` key present at
  all — confirms the default and an explicit zero agree).
- `grain=1` measurably increases pixel-value variance vs. `grain=0` on the same
  `intensity=1` (fully desaturated) base, sampled over a small fixed grid of points via
  `GetPoint` (no new govips wrapper needed for this — a plain Go variance computation over
  sampled points, same level of primitive `channelSpread` already uses).
- `grain=1` on an `intensity=1` base keeps the image's overall average within a small
  tolerance of the ungrained version (noise is zero-mean, so the average shouldn't drift
  much — bounds the "silently shifted brightness" failure mode verification point 1 above
  exists to catch).
- Determinism: two separate calls with identical params produce byte-identical output
  (fixed seed).
- `grain` out of range (`-0.1`, `1.1`) is a validation error, following the existing
  `intensity`/`neutrals`/`tone` range-error test loop's shape.
- `grain=1` on an RGBA input leaves the alpha channel unchanged (needs a small synthetic
  RGBA fixture — reuse/extend `writeUniformJPEG`-style helper in `helpers_test.go`, or a
  small PNG since JPEG has no alpha; verification point 4 above is exactly the bug this
  guards against).

### `apps/web/src/lib/recipe/schema.ts` (edit)

- `blackAndWhiteParamsSchema` gains `grain: z.number().min(0.0).max(1.0).default(0.0)` —
  optional/defaulted like `adjustColorParamsSchema`'s `castStrength`, so pre-existing
  recipes keep validating.
- Doc comment above `blackAndWhiteParamsSchema` updated: `grain` moves from "deferred,
  D-28" to implemented.

### `apps/web/src/lib/recipe/schema.test.ts` (edit)

Range-boundary tests for `grain` (0.0/1.0 accepted, below 0/above 1 rejected, absent
defaults to 0.0), following the existing `castStrength`/`highlights`/`shadows` default-field
test pattern.

Not changed: WebGPU/WebGL2 preview shaders and the editor UI (`BlackAndWhiteControl.tsx`) —
no Grain slider or preview-parity pass yet, same two-phase split (`V-7`→`D-25`,
`D-27`→`D-30`) used for the previous two composite params. Tracked as a new `D-31` in the
deferred register, not silently dropped.

## Porquê

`D-28` names this as the explicit next step and it's fully unblocked once the fork wrapper
exists — same shape of fix `D-24` already validated for `Tonelut`, not new research.
Verifying `vips_gaussnoise`'s actual default `mean`, `Composite`'s alpha-synthesis side
effect, `Add`'s alpha-corruption gap, the dimension-mismatch silent-resize gap, and the
non-reproducible-default-seed gap against a real libvips build (not assumed from the spike
doc's summary) matters here specifically: the spike doc correctly identified the primitives
that exist, but "scaling the noise image's contrast/mean toward neutral gray via `Linear1`"
(its own suggested approach) turns out to be unnecessary and more complex than just passing
`mean: 0` directly to the generator — and none of the five gaps above were visible from
reading `generated.go`'s signatures alone. This is the same kind of implementation-detail
verification `TASK-adjust-color-cast.md` did for `Stats()`/`GetPoint` and `vips_linear`'s
coefficient-length rule before writing any processor code.

Choosing `BandJoin`+`Add` over `Composite`+`BlendMode` (the spike doc's original
suggestion) is a real design decision made here, not a deviation to flag as a compromise:
`Composite`'s alpha semantics are the wrong tool for "add a texture to every pixel
uniformly" — this codebase's own `black_and_white.go` already blends layers with plain
`Add`/`Linear1`, not `Composite`, for exactly this reason (the intensity blend needs no
alpha-aware Porter-Duff math either).

Shipping a documented first-pass `grainMaxSigma`/seed rather than blocking on `D-29`'s
research-that-doesn't-exist mirrors the precedent this exact file already set for
`neutrals`' skew formula: CLAUDE.md §0 bans inventing an unverified *technical* claim (codec
behavior, browser capability, primitive semantics) presented as fact, not a labeled,
revisitable creative default. The five verification points above are the technical claims,
and they're all confirmed against real libvips. The sigma cap is not presented as
researched — it says so in its own doc comment, same as `grayscaleMatrix` already does.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `docs/tasks/TASK-black-and-white-grain.md` | new | this document |
| `workers/internal/govips-fork/vips/gaussnoise.go` | new | `NewGaussnoiseImage` wrapper, mirrors `tonelut.go` |
| `workers/internal/processors/black_and_white.go` | edit | implement `grain` param, update doc comment |
| `workers/internal/processors/black_and_white_test.go` | edit | no-op/variance/determinism/range/alpha-safety tests |
| `workers/internal/processors/helpers_test.go` | edit | small sampled-variance helper and/or RGBA fixture helper if not already reusable |
| `apps/web/src/lib/recipe/schema.ts` | edit | add `grain` to `blackAndWhiteParamsSchema`, update doc comment |
| `apps/web/src/lib/recipe/schema.test.ts` | edit | range/default tests for `grain` |
| `docs/90-deferred-register.md` | edit | resolve `D-28`; update `D-29` (Grain's mapping is now implemented-but-untuned, not unstarted); add `D-31` (preview shader + editor UI parity for `grain`, same shape as `D-25`/`D-30`) |
| `docs/plexus-media-pipeline-spec.md` | edit | if `image.blackAndWhite`'s param list is enumerated anywhere, update it same as prior composite-param tasks did |
