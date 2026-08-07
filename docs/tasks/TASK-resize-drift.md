# TASK-resize-drift — measure `image.resize` preview/export drift (V-6)

## Cenário actual (`Current scenario`)

`TASK-recipe-fidelity-drift.md` (2026-08-07) built a cross-language drift-measurement
harness for the four composite controls (`image.adjustLight`/`adjustColor`/
`blackAndWhite`/`sharpen`): `workers/cmd/gendriftfixture` synthesizes
`testdata/drift/source.png` (128×128 — gradient / hue-patch / checkerboard thirds),
`workers/cmd/gendriftgolden` runs the real Go processors against it and dumps raw RGBA8
goldens to `testdata/drift/golden/`, and `apps/web/src/lib/preview/drift.test.ts` runs
`color-math.ts`'s pure-TS reference math against the same source pixels and asserts
measured MAE/max-error/mean-ΔE bounds. That work closed `V-2` — Light/Color/B&W are near
bit-exact, Sharpen needed a coring fix (`TASK-sharpen-coring-fix.md`) to get close.

`V-6` (`docs/90-deferred-register.md`) was opened alongside that work and explicitly
excluded from it: "`image.resize`'s drift is explicitly out of scope — different mechanism
(geometry vs. per-pixel color), its own follow-up." Its claim was unverified: whether the
live preview's resize (`apps/web/src/lib/preview/{webgpu,webgl2}-renderer.ts`, GPU
hardware bilinear texture sampling — `device.createSampler({ magFilter: 'linear', minFilter:
'linear' })` in `webgpu-renderer.ts:378`, `gl.TEXTURE_MIN_FILTER`/`MAG_FILTER = gl.LINEAR`
in `webgl2-renderer.ts:337-338`/`418-419`) uses the same interpolation kernel as the Go
export path (`workers/internal/processors/resize.go:53`'s `img.Thumbnail(width, height,
crop)`, calling govips v2.18.0's `ImageRef.Thumbnail` → C `vips_thumbnail_image`).

**Confirmed in this pass, against libvips' own primary source** (fetched 2026-08-07 from
`raw.githubusercontent.com/libvips/libvips/master/libvips/resample/{thumbnail,resize}.c`,
`master` branch): `vips_thumbnail_image`'s main-image resize call in `thumbnail.c` passes
no `"kernel"` argument (`govips`'s own C shim, `vips/operations.c:481-501`, confirms this —
no `kernel` param is passed through from Go either), so it falls back to `vips_resize`'s own
default. `libvips/resample/resize.c`'s `vips_resize_class_init` registers:

```c
VIPS_ARG_ENUM(class, "kernel", 3,
    _("Kernel"),
    _("Resampling kernel"),
    VIPS_ARGUMENT_OPTIONAL_INPUT,
    G_STRUCT_OFFSET(VipsResize, kernel),
    VIPS_TYPE_KERNEL, VIPS_KERNEL_LANCZOS3);
```

and `vips_resize_init` sets `resize->kernel = VIPS_KERNEL_LANCZOS3`. So: **Go export
resizes with Lanczos3 (windowed sinc); the live preview resizes with hardware bilinear
(linear interpolation)** — a real algorithmic difference, not an implementation-detail
rounding gap. Unlike the four composite controls, which V-2 found to be near-bit-exact
despite being independently reimplemented, there is no a priori reason to expect resize to
be close: Lanczos3 has ringing/overshoot near edges and a sharper falloff; bilinear just
blurs. No drift number exists today for resize — `apps/web/src/lib/preview/geometry.ts`
(the UV-rect crop/scale math both renderers share) has its own unit tests
(`geometry.test.ts`), but they check the rect arithmetic only, never actual pixel output.

## Mudanças planeadas (`Planned changes`)

1. **`workers/cmd/gendriftgolden/main.go`** — add a `resize` golden group calling
   `processors.Resize` (already registered in `registry.go`, same `processors.Func` shape
   the other four groups use — no interface change needed) against the existing committed
   `testdata/drift/source.png`, at three representative points:
   - `resize-inside-half` — `{width: 64, height: 64, fit: "inside"}`: plain 2× downscale,
     no crop, exercises the checkerboard region's edge response most directly.
   - `resize-cover-crop` — `{width: 96, height: 48, fit: "cover"}`: aspect change forces a
     centered crop, exercising `sourceUV` (not just uniform scale).
   - `resize-inside-upscale` — `{width: 192, height: 192, fit: "inside"}`: 1.5× upscale,
     where Lanczos3 vs. bilinear differ most visibly (pure interpolation, no
     downscale-antialiasing question muddying the comparison).
   `dumpRGBA` already reads width/height off the real output image (`img.Width()`/
   `img.Height()`), so it needs no change to handle resize's varying output dimensions.

2. **`apps/web/src/lib/preview/drift.test.ts`** — add a test-local `bilinearResample(source,
   geometry)` function, following the file's existing precedent (`gaussianBlur` is already
   kept test-local rather than promoted into renderer code, since neither renderer exposes
   "run one resample, return pixels" as a callable unit — they render straight to a canvas).
   It reproduces exactly what `BLIT_VERTEX_SHADER_SOURCE`/`BLIT_FRAGMENT_SHADER_SOURCE`
   (`webgl2-renderer.ts:23-49`) and the WebGPU equivalent do: for each output pixel at local
   UV `(x+0.5)/outW, (y+0.5)/outH`, `mix()` into the `sourceUV` rect from
   `computeFitGeometry()` (imported from `./geometry`, not re-derived), then bilinear-sample
   the source raster in source-pixel space with clamp-to-edge addressing (matches
   `gl.CLAMP_TO_EDGE`, set explicitly in `webgl2-renderer.ts:339-340`/`420-421`; WebGPU's
   `createSampler` call in `webgpu-renderer.ts:378` sets no `addressModeU`/`V`, relying on
   the WebGPU spec's own default of `"clamp-to-edge"` — `[VERIFY: confirm this default
   directly against the WebGPU spec's `GPUSamplerDescriptor` section before depending on it
   elsewhere; both backends need to agree, and WebGL2's setting is already explicit so this
   is the one side still resting on a spec-default assumption]`). Output canvas dimensions
   follow the renderers' own `Math.max(1, Math.round(geometry.outputWidth/Height))`
   (`webgl2-renderer.ts:552-553`, `webgpu-renderer.ts:540-541`) so rounding behavior matches
   production, not just the raw float geometry.

   Add a new `describe('image.resize (V-6)')` block with `it.each` over the three points
   above: load the matching golden via the existing `readRaster`, run `bilinearResample`
   against `source` with `computeFitGeometry(source dims, params)`, measure with the
   existing `measureDrift`, and assert against a new `RESIZE_BOUNDS` set from the actual
   measured numbers once run (same convention as `LIGHT_BOUNDS`/`COLOR_BOUNDS`/etc. — margin
   chosen after measuring, not guessed first).

3. **`docs/90-deferred-register.md`** — resolve `V-6`: record the confirmed Lanczos3-vs-
   bilinear mechanism (with the primary-source citation above) and the measured drift
   numbers/bounds. Given the two algorithms are genuinely different rather than differently-
   rounded versions of the same one, drift here is expected to be materially larger than the
   near-bit-exact composite controls — if the measured numbers are large enough that
   "preview and export visibly disagree" is a fair characterization, add a new `D-xx`
   ("live preview approximates resize with bilinear, not Lanczos3, measured drift is
   large") with a re-evaluation trigger, rather than attempting a multi-tap Lanczos shader
   in this task. A real Lanczos3 approximation in a fragment shader is materially more
   shader complexity (multi-tap kernel, 3–6× the texture reads per output pixel, no
   existing precedent in this codebase) than this task's scope justifies before a measured
   number proves bilinear insufficient — consistent with CLAUDE.md's "no code for
   hypothetical requirements."

## Porquê (`Why`)

`V-6` has sat unresolved in the deferred register since `TASK-preview-renderer.md`
(2026-08-06) as the one case explicitly carved out of `V-2`'s now-closed drift work.
CLAUDE.md's Tests section requires "a numeric bound per composite control, and a test that
enforces it" for recipe fidelity; `image.resize` is a P0 pipeline/editor operation
(`docs/plexus-media-pipeline-spec.md`) and today nothing verifies preview and export agree
on it at all, let alone by how much — `V-6`'s own re-evaluation trigger ("before recipe
fidelity is claimed as a met success metric for any recipe containing a resize step") is
still unmet. Per CLAUDE.md §0's "never invent... browser capability; write `[VERIFY]`
instead of guessing," the kernel claim needed confirming against libvips' own source before
treating it as fact — done in this pass via a direct fetch of `resize.c`/`thumbnail.c` from
libvips' `master` branch, not assumed from training-data memory. Because the confirmed
mismatch is a genuinely different algorithm (windowed sinc vs. linear interpolation), not a
rounding-mode difference, this task is likely to be the first case in the register where
measurement shows a real, non-trivial preview/export gap — which is exactly the outcome the
fidelity-measurement discipline exists to surface and document, not something to route
around by skipping the measurement.

## Ficheiros afectados (`Affected files`)

| File | Change type | Notes |
|---|---|---|
| `workers/cmd/gendriftgolden/main.go` | edit | add `resize` golden group (3 points: inside-half, cover-crop, inside-upscale) using existing `processors.Resize` |
| `testdata/drift/golden/resize-inside-half.rgba` | new | generated by `go run ./cmd/gendriftgolden`, committed |
| `testdata/drift/golden/resize-cover-crop.rgba` | new | generated by `go run ./cmd/gendriftgolden`, committed |
| `testdata/drift/golden/resize-inside-upscale.rgba` | new | generated by `go run ./cmd/gendriftgolden`, committed |
| `apps/web/src/lib/preview/drift.test.ts` | edit | add test-local `bilinearResample`, `RESIZE_BOUNDS`, new `describe('image.resize (V-6)')` block |
| `docs/90-deferred-register.md` | edit | resolve `V-6` with measured numbers + primary-source kernel citation; add new `D-xx` if drift is large enough to be a real accepted-debt item, not just a closed unverified-claim |
