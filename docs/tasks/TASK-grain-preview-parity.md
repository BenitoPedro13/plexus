# TASK-grain-preview-parity — live-preview shader + editor UI for image.blackAndWhite.grain (D-31)

## Cenário actual

`docs/90-deferred-register.md`'s `D-31` records that **Grain** (`image.blackAndWhite`'s
fourth P0 param, implemented Go-side in `TASK-black-and-white-grain.md`, resolved `D-28`)
has no live-preview shader pass and no editor UI control — the same two-phase split
(`V-7`→`D-25` for Light's highlights/shadows, `D-27`→`D-30` for Color's castStrength)
already used twice for this codebase's other two "Go implemented, preview not yet" gaps.

Today:

- `apps/web/src/lib/recipe/schema.ts`'s `blackAndWhiteParamsSchema` already has `grain:
  0.0..1.0`, optional/defaulted to `0.0`.
- `apps/web/src/lib/preview/color-math.ts`'s `applyBlackAndWhite(pixel, params)` only reads
  `intensity`/`neutrals`/`tone` — `grain` is accepted in the type but silently ignored.
- `apps/web/src/lib/preview/webgpu-renderer.ts`'s `BLACK_AND_WHITE_WGSL` and
  `apps/web/src/lib/preview/webgl2-renderer.ts`'s `BLACK_AND_WHITE_FRAGMENT_SHADER_SOURCE`
  both declare a 4-float uniform (`params`/`uParams`, a `vec4f`/`vec4`) but only read
  `.x`/`.y`/`.z` — `.w` is unused, and `encodeAdjustmentStep`/`runContentPass`'s call sites
  only pass `[intensity, neutrals, tone]` (3 values), leaving `.w` at whatever padding value
  `encodeUniformPass`/`runContentPass` puts there (0, harmless, but grain is simply never
  wired through).
- `apps/web/src/components/editor/BlackAndWhiteControl.tsx` has Intensity/Neutrals/Tone
  sliders only — no Grain slider.
- `apps/web/src/app/preview-demo/page.tsx` hardcodes `grain: 0` in its recipe object — no
  Grain input.
- `apps/web/src/lib/preview/drift.test.ts`'s `bwPoints` both pin `grain: 0.0` — grain is
  never exercised by the drift harness at all.

So dragging a hypothetical Grain slider today would change the recipe's `grain` param (Zod
accepts it) but the live preview would render identically to `grain=0` — the same
preview/export mismatch bug shape `D-25`'s own task doc found and fixed for
`adjustLight`'s highlights/shadows (that one was a missing-recipe-step bug in
`deriveRecipe`; this one is a missing-shader-read bug, but the user-facing symptom is the
same: "I moved a slider and nothing happened").

## Mudanças planeadas

### The real design question: grain cannot be drift-tested the way every other control is

Every other composite control's preview math (`applyAdjustLight`, `applyAdjustColor`,
`applyBlackAndWhite`'s existing three params, `applyUnsharpMask`) is a **deterministic**
per-pixel (or spatially-local) function: given the same input pixel(s) and params, Go and
the TS/GPU preview compute values that either match closely (Light, Color, B&W's first
three params — all "near bit-exact" per `drift.test.ts`'s bounds) or diverge for a
documented algorithmic reason (`image.resize`'s Lanczos3-vs-bilinear gap, `D-23`). That's
what makes `drift.test.ts`'s golden-fixture-vs-CPU-reference methodology (`V-2`) meaningful:
both sides are computing *the same function*, so per-pixel MAE/max/ΔE bounds measure real
approximation error.

Grain is not that kind of function. `black_and_white.go`'s `applyGrain` calls
`vips.NewGaussnoiseImage(..., Seed: &grainNoiseSeed)` — libvips' own internal
pseudo-random-number generator, seeded but never documented or reverse-engineered anywhere
in this codebase (and CLAUDE.md §0 bans presenting a guessed algorithm as fact; actually
porting libvips' C-level PRNG bit-for-bit is out of scope and not attempted here). No
shader-side noise function will ever reproduce libvips' *specific* per-pixel values — only
its *statistical shape* (zero mean, a standard deviation that scales with `grain`,
Gaussian-ish) can plausibly match. Concretely: two independent zero-mean Gaussian noise
fields with the same σ disagree by `E|X−Y| = σ·√(4/π) ≈ 1.128σ` per pixel on average (X−Y is
itself Gaussian, variance 2σ²) — at `grain=1.0` (σ=25/255 in shader-normalized units, i.e.
σ≈25 in Go's 0..255 scale), that's a mean absolute per-pixel disagreement around **28**,
roughly **40×** `BW_BOUNDS`'s existing `mae: 0.7`. Adding a grain point to `drift.test.ts`'s
`bwPoints` under the existing methodology would either force `BW_BOUNDS` open so wide it
stops catching real regressions in `intensity`/`neutrals`/`tone`, or the test would simply
never pass — neither outcome is useful, and quietly loosening a shared bound to
accommodate an unrelated control would be exactly the kind of silent regression-risk
CLAUDE.md's testing section warns against.

Decision: grain gets a **separate validation strategy**, not folded into the existing
per-pixel drift harness:

1. The preview's grain is a self-contained, documented pseudo-random hash evaluated per
   fragment coordinate (`sin`-hash → Box-Muller, detailed below) — a plausible, GPU-cheap
   *visual stand-in*, explicitly not an attempt to reproduce libvips' actual noise pattern.
   Deterministic per pixel coordinate (not time-seeded), so the grain pattern is stable
   while a user drags the slider or orbits other controls — it doesn't shimmer frame to
   frame, matching what a real "grain" look should feel like live even though it isn't
   literally the same noise Go will burn in at export.
2. Fidelity is validated **statistically** in `color-math.test.ts` (mean ≈ 0, standard
   deviation scaling linearly with `grain`, measured over a large sampled coordinate grid) —
   not via a new `drift.test.ts`/`gendriftgolden` golden-fixture point.
3. This is new, distinct methodology debt from every existing `V-2`/`D-23`/`D-30` entry —
   recorded as new `D-32` in the deferred register, not silently different from precedent.

### `apps/web/src/lib/preview/color-math.ts` (edit)

- New exported `grainNoiseNormalized(coordX: number, coordY: number, grain: number): number`
  — the CPU-reference noise generator:
  - `hash(x, y) = frac(sin(x*12.9898 + y*78.233) * 43758.5453123)` (a standard, widely-used
    GPU pseudo-random hash — a shader *technique*, not a claim about libvips/browser
    behavior, so no `[VERIFY]` needed; documented as such in the doc comment).
  - Two hash evaluations at `(coordX, coordY)` and `(coordX + 37, coordY + 17)` (arbitrary
    fixed offset, only needs to decorrelate the two samples) give `u1`, `u2` ∈ [0, 1);
    `u1` floored at `1e-6` before `log()` (same divisor-floor discipline as this file's own
    `CAST_MEAN_EPSILON`/`CHROMA_EPSILON`).
  - Box-Muller: `z0 = sqrt(-2*log(u1)) * cos(2*PI*u2)` — standard normal, mean 0, σ=1.
  - Returns `z0 * grain * GRAIN_MAX_SIGMA_NORMALIZED`, where `GRAIN_MAX_SIGMA_NORMALIZED =
    25.0 / 255.0` mirrors `black_and_white.go`'s `grainMaxSigma = 25.0` (Go's 0..255 scale)
    converted to this file's 0..1 convention — same conversion pattern the file's own
    top-of-file comment already establishes for `applyAdjustLight`.
- `applyBlackAndWhite(pixel, params, coord?: { x: number; y: number })` gains the optional
  third parameter — same "optional, required only when the feature is active" shape as
  `applyAdjustColor`'s `mean`. When `params.grain !== 0`, throws if `coord` is omitted
  (mirrors `applyAdjustColor`'s `mean` guard exactly); when `params.grain === 0`, `coord` is
  never read, so every existing call site (`drift.test.ts`'s `bwPoints`, both pinned to
  `grain: 0`) needs no change.
- Grain noise is added to the mixed RGB **after** the existing intensity/tone blend, before
  the final `clamp01` — matches `black_and_white.go`'s `applyGrain` running last ("a
  property of the final print, not an input layer"), and matches this file's own
  top-of-file convention ("clamping happens once, at the very end of a pass"). Alpha is
  untouched (the function never reads/writes `pixel.a` beyond passthrough) — same
  alpha-safety property `applyGrain`'s `BandJoinConst([]float64{0})` establishes Go-side,
  achieved here for free since the noise is only added to the RGB channels.

### `apps/web/src/lib/preview/webgpu-renderer.ts` (edit)

- `BLACK_AND_WHITE_WGSL` gains a `hash`/`gaussianNoise` WGSL translation of the above
  (`fragment_main`'s existing `in: VertexOutput` parameter already carries
  `@builtin(position) position: vec4f` per `VertexOutput`'s struct definition — reused
  directly as `in.position.xy`, the same "position field doubles as fragCoord in the
  fragment stage" mechanism `MEAN_DOWNSAMPLE_WGSL` already relies on for its `outCoord`, no
  new binding needed).
- Reads `let grain = params.w;` (the uniform's 4th component, already declared as `vec4f`
  and already unused — no bind-group-layout change).
- `encodeAdjustmentStep`'s `case 'image.blackAndWhite'` passes `[intensity, neutrals, tone,
  grain]` (4 values) instead of 3 — `encodeUniformPass`'s existing `Math.ceil(n/4)` chunking
  logic handles this with zero change (still 1 chunk).

### `apps/web/src/lib/preview/webgl2-renderer.ts` (edit)

- Same shape: `BLACK_AND_WHITE_FRAGMENT_SHADER_SOURCE` gains the GLSL ES 300 hash/Box-Muller
  helpers, reads `uParams.w` as `grain`, uses the already-available `gl_FragCoord.xy`
  builtin (same one `MEAN_DOWNSAMPLE_FRAGMENT_SHADER_SOURCE` already uses) for the noise
  coordinate.
- The `case 'image.blackAndWhite'` call site passes `[intensity, neutrals, tone, grain]`
  (4 values) to `runContentPass` — `ContentProgram`'s existing single-`uParams`-vec4 path
  already handles up to 4 values with no `uParams2` needed (unlike `adjustLight`'s 6).

### `apps/web/src/components/editor/BlackAndWhiteControl.tsx` (edit)

- New "Grain" slider, `0..1`, `step={0.05}` — same pattern as the existing three sliders,
  inserted after Tone. No new fan-out/master-blend behavior (matches this component's own
  precedent: curated raw params, no invented composite slider).

### `apps/web/src/app/preview-demo/page.tsx` (edit)

- New `grain` state (`useState(0)`), a Grain range input in the "B&W" fieldset (mirrors the
  existing `bwIntensity`/`neutrals`/`tone` inputs), recipe's `image.blackAndWhite` params
  gain `grain` (replacing the hardcoded `grain: 0`).

### `apps/web/src/lib/preview/color-math.test.ts` (edit)

New `describe` block (or extension of the existing `applyBlackAndWhite` block) covering:

- `grain: 0` is unaffected by `coord` being omitted (no throw, same result as before this
  task).
- `grain !== 0` with no `coord` throws (mirrors the existing `applyAdjustColor`
  "mean is required" throw test).
- Determinism: same `(pixel, params, coord)` called twice returns byte-identical output.
- Different `coord`s at the same nonzero `grain` produce different output (confirms the
  noise actually varies spatially, not a constant offset).
- Statistical test: sample `grainNoiseNormalized` over a fixed large grid (e.g. 100×100
  coordinates) at a fixed `grain` value; assert the sample mean is within a small tolerance
  of 0 and the sample standard deviation is within a measured tolerance of
  `grain * GRAIN_MAX_SIGMA_NORMALIZED` (bounds calibrated from an actual run against this
  grid size, per CLAUDE.md §0 — not guessed ahead of measurement, written up with the
  observed numbers once run, same convention `drift.test.ts`'s `DriftBounds` comments use).
- Repeat the standard-deviation check at two different `grain` values (e.g. 0.5 and 1.0) to
  confirm linear scaling, not just a single-point check.

### `docs/90-deferred-register.md` (edit)

- Resolve `D-31` with what actually shipped.
- New `D-32`: grain's preview fidelity is validated statistically
  (`color-math.test.ts`), not via `drift.test.ts`'s per-pixel golden-fixture methodology —
  documents the σ-disagreement math above as the reason, and notes this is deliberate,
  permanent methodology debt (not "not yet done") since no shader-side noise function can
  ever pixel-match an unreverse-engineered PRNG.

### `docs/plexus-media-pipeline-spec.md` (edit)

- If `image.blackAndWhite`'s param list / preview-parity status is enumerated anywhere,
  update it the same way prior composite-param tasks did.

## Porquê

`D-31` names this as the direct next step, explicitly scoped the same as the two prior
"Go done, preview not yet" gaps this codebase already closed twice (`D-25`, `D-30`) — same
kind of fix, not new research, for the WGSL/GLSL/UI wiring itself.

The one real design decision here — and the reason this isn't a copy-paste of
`TASK-color-cast-preview-parity.md` — is recognizing that grain's *validation* can't follow
`D-25`/`D-30`'s pattern. Those two extended `drift.test.ts` with new golden-fixture points
because both sides of the comparison were computing the same deterministic function
(tonelut's Hermite curve; grey-world's exact arithmetic mean). Grain's Go-side and
preview-side noise are two different, uncorrelated random processes by construction — no
amount of shader tuning closes that gap, because the point of `Seed: &grainNoiseSeed` in
`black_and_white.go` is Go-side reproducibility (recipe → same export twice), not
cross-runtime pixel matching, and the two runtimes were never going to share a PRNG. Adding
a golden-fixture point anyway and hand-waving a loose bound would be worse than the honest
alternative: validate what's actually true (the noise is zero-mean and scales correctly with
the slider) with a statistical test, and record the methodology gap explicitly (`D-32`)
instead of leaving a future reader to wonder why `bwPoints` never grew a grain entry the way
`colorPoints` grew `color-cast-*` entries for `D-30`.

The hash/Box-Muller choice itself needs no `[VERIFY]`: it's a self-contained shader
algorithm (like the WGSL/GLSL Hermite-curve translation `D-25` already did with
`smoothstep()`), not a claim about an external system's behavior — CLAUDE.md §0's
verification requirement is about codec/protocol/browser-capability facts, not about how the
preview chooses to implement its own approximation.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `docs/tasks/TASK-grain-preview-parity.md` | new | this document |
| `apps/web/src/lib/preview/color-math.ts` | edit | `grainNoiseNormalized`, `applyBlackAndWhite` gains optional `coord` param and grain blend |
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | `BLACK_AND_WHITE_WGSL` hash/Box-Muller + `params.w`, `encodeAdjustmentStep` passes 4 values |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | `BLACK_AND_WHITE_FRAGMENT_SHADER_SOURCE` hash/Box-Muller + `uParams.w`, call site passes 4 values |
| `apps/web/src/components/editor/BlackAndWhiteControl.tsx` | edit | new Grain slider |
| `apps/web/src/app/preview-demo/page.tsx` | edit | new Grain state + input, wired into recipe |
| `apps/web/src/lib/preview/color-math.test.ts` | edit | throw/determinism/statistical-scaling tests for grain |
| `docs/90-deferred-register.md` | edit | resolve `D-31`; add `D-32` (grain preview validated statistically, not via per-pixel drift) |
| `docs/plexus-media-pipeline-spec.md` | edit | update `image.blackAndWhite` preview-parity status if enumerated |
