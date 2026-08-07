# TASK-fix-adjustcolor-wgsl-reserved-word

## Cenário actual

User-reported bug (live in `/editor`, real photo, WebGPU backend): touching the Color
panel's Saturation slider by even one step (±0.05) makes the entire preview canvas go
solid black. Every other composite control (Light, Cast, Black & White, Sharpen) renders
correctly; the bug is specific to `image.adjustColor`'s Saturation param, and only once a
recipe actually includes an `image.adjustColor` step — `apps/web/src/app/editor/page.tsx`'s
`deriveRecipe` only pushes that step when `saturation !== 0 || castStrength !== 0`
(line 62), so the broken code path was never exercised until a real user touched Saturation
on a real photo through the full `/editor` UI (as opposed to `preview-demo`, which is where
`TASK-color-cast-preview-parity.md`'s manual verification happened).

Root cause, confirmed directly from the browser's own DevTools console (not guessed):

```
Error while parsing WGSL: :92:7 error: 'target' is a reserved keyword
  let target = (mean.r + mean.g + mean.b) / 3.0;
      ^^^^^^
 - While calling [Device].CreateShaderModule([ShaderModuleDescriptor]).
```

`apps/web/src/lib/preview/webgpu-renderer.ts`'s `ADJUST_COLOR_WGSL` shader (added in
`TASK-color-cast-preview-parity.md`, resolved `D-30`) declares `let target = ...` inside
`fragment_main`. `target` is on WGSL's reserved-word list (reserved for future language use,
per the WGSL spec) — a real, spec-level restriction, not a driver quirk. This fails
`device.createShaderModule()` for `adjustColorPipeline`, which cascades exactly as the
console output shows: invalid shader module → invalid render pipeline → invalid bind group
layout → invalid bind group → invalid command buffer → `queue.submit()` on an invalid
command buffer is a silent no-op (no JS exception, no thrown error `PreviewCanvas.tsx` could
catch) — so the canvas simply never receives a new frame and shows whatever the last
`loadOp: 'clear'` pass wrote, which is the blit pass's own black clear color
(`clearValue: { r: 0, g: 0, b: 0, a: 1 }`, `webgpu-renderer.ts` line ~745).

This is WebGPU-only. `apps/web/src/lib/preview/webgl2-renderer.ts`'s GLSL ES equivalent
(`float target = ...`) is unaffected — `target` is not a reserved word in GLSL ES — so the
WebGL2 fallback path was never broken; screenshots confirmed the bug specifically with
`backend: webgpu` showing in the status line.

## Mudanças planeadas

**`apps/web/src/lib/preview/webgpu-renderer.ts`** (edit)
- `ADJUST_COLOR_WGSL`'s `fragment_main`: rename `target` → `greyTarget` (and its one use
  site in the `scale` computation). No other logic change — this is a pure identifier
  rename to unblock shader compilation, not a formula change.

**`apps/web/src/lib/preview/webgl2-renderer.ts`** (edit)
- Same rename in the GLSL fragment shader's `float target = ...` → `float greyTarget = ...`.
  Not required for correctness (GLSL doesn't reserve this word), done for cross-shader
  naming consistency — every other shared helper/variable in this file already mirrors its
  WGSL counterpart 1:1, and leaving one shader's variable name to drift after this fix would
  undermine that convention on the very variable that caused the bug.

**`apps/web/src/lib/preview/color-math.ts`** (edit)
- `applyCast`'s `const target = ...` → `const greyTarget = ...`, same consistency reasoning
  as the GLSL rename — the CPU reference, WGSL, and GLSL implementations are meant to read
  as the same algorithm in three languages; this closes the one place they'd diverged.

No test-suite change: `color-math.test.ts`/`drift.test.ts` exercise `applyCast` and
`applyAdjustColor` by their public API and already pass — this is an internal rename with
no observable behavior change on the CPU-reference path. The actual regression (WebGPU
shader compilation) has no automated coverage today, same pre-existing gap
`docs/90-deferred-register.md`'s `D-30` already notes ("no automated test exercises actual
WGSL/GLSL execution in a browser") — flagged below as a new deferred-register entry rather
than silently left unaddressed.

**`docs/90-deferred-register.md`** (edit)
- Add a new `D-xx` entry: this bug is the concrete case `D-30`'s own caveat predicted —
  shader-compilation regressions in WGSL/GLSL have zero automated coverage, so a reserved
  word (or any other shader-only syntax error) can ship silently until a real user hits the
  exact code path in a real browser. Records the gap and what closing it would take
  (headless-browser WebGPU/WebGL2 shader-compile smoke test in CI), without attempting that
  infrastructure in this fix.

## Porquê

This is a P0-breaking regression: Color's Saturation slider is one of the spec's four
required composite controls (`docs/plexus-media-pipeline-spec.md`'s P0 "curated composite
controls" bullet) and it currently makes the live preview unusable the moment it's touched
on the default (WebGPU) backend. Fixing it is unambiguous — the console output identifies
the exact line and exact spec-level cause, no design judgment call involved, unlike the
visual-tuning items already parked in `D-22`/`D-29`.

Renaming across all three implementations (not just the broken WGSL one) is the right scope
for a one-line identifier fix: this codebase's whole review discipline for these shaders is
"mirrors X exactly" comments cross-referencing the other two languages line-for-line: leaving
`target` in GLSL/TS while WGSL alone says `greyTarget` would itself become a paper cut the
next person maintaining this file has to puzzle over, for zero benefit — the fix is
free to make consistent everywhere at the same time it's made in the one place it's required.

The new deferred-register entry matters because this exact failure mode (a reserved-word or
other shader-syntax error shipping silently, discovered only by a real user on a real
photo) is precisely the risk `D-30`'s own resolution note already flagged as unverified and
did nothing further about. Recording it now, with the concrete incident as evidence, is what
turns "unverified risk" into "confirmed risk with one real occurrence" — the kind of signal
that should raise this gap's priority the next time someone is deciding what to build next,
rather than leaving it as an abstract caveat nobody revisits.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/preview/webgpu-renderer.ts` | edit | rename `target` → `greyTarget` in `ADJUST_COLOR_WGSL` (the actual bug fix) |
| `apps/web/src/lib/preview/webgl2-renderer.ts` | edit | same rename in the GLSL equivalent, for cross-shader consistency |
| `apps/web/src/lib/preview/color-math.ts` | edit | same rename in `applyCast`'s CPU reference, for cross-implementation consistency |
| `docs/90-deferred-register.md` | edit | new entry: no automated WGSL/GLSL shader-compilation coverage, confirmed by this real incident |
