# TASK: Highlights/Shadows via a local govips `tonelut` wrapper (resolve V-7)

## Cenário actual (Current scenario)

`image.adjustLight` (`workers/internal/processors/adjust_light.go`) implements exactly the
P0 param subset from `TASK-composite-slider-mapping.md`: `exposure`, `brightness`,
`contrast`, `blackPoint`, each a `Linear1` pass. `brilliance`, `highlights`, `shadows` are
explicitly deferred — both the Go doc comment (line 32) and the Zod schema
(`apps/web/src/lib/recipe/schema.ts` line 47, `adjustLightParamsSchema`) say so, blocked on
`V-7` in `docs/90-deferred-register.md`.

`V-7`'s claim: `govips`'s generated set contains an internal `vipsGenTonelut` binding
(confirming libvips itself exposes `tonelut`), but no exported `(*ImageRef)` wrapper —
only `Maplut`, `Sharpen`, `Recomb` are exported from that generated set. libvips
maintainers' own recommended shadows/highlights approach
([discussion #4036](https://github.com/libvips/libvips/discussions/4036)) is a
`tonelut`→`maplut` pipeline on the LABS L channel.

**Re-verified this session, still true at `govips@v2.18.0`** (current latest release — no
newer version exists; checked via `go list -m -versions`). Confirmed directly by extracting
the module source (`$(go env GOMODCACHE)/github.com/davidbyttow/govips/v2@v2.18.0/vips/`):

- `generated.go`/`generated.c`/`generated.h` contain `vipsGenTonelut`/`GenTonelutOpts` and
  `gen_vips_tonelut` (unexported, cgo-internal).
- No file under `vips/` calls `vipsGenTonelut` — genuinely dead code from the wrapper
  package's own perspective today.
- The blocker is **deeper than "just missing a wrapper function"**: `ImageRef`'s `image
  *C.VipsImage` field and the `newImageRef(...)` constructor (`vips/image.go:718`) are
  both unexported. `tonelut` takes no input image (it's a from-scratch LUT generator, unlike
  `Sharpen`/`Recomb`/the already-exported `Maplut`, which all operate on an existing
  `r.image`) — so there is no way to obtain a `*ImageRef` wrapping its output from outside
  the `vips` package. A same-package addition (i.e. a **local fork**, not a wrapper file in
  our own repo) is the only option; cgo types from two different Go packages that both
  `import "C"` against the same header are not interchangeable, and reflection/unsafe
  hacks to populate an unexported struct field are not something to build production code
  on.

Also newly confirmed, needed to actually wire `tonelut`'s output into the LABS L channel
(not previously verified anywhere in this repo):

- **`tonelut`'s exact parameter semantics** — from libvips' own doc comment,
  `libvips/create/tonelut.c` (`github.com/libvips/libvips`, default branch, fetched this
  session): `in_max`/`out_max` (LUT size/range, default 32767/32767), `Lb`/`Lw`
  (black/white point, 0-100 scale, default 0/100), `Ps`/`Pm`/`Ph` (shadow/mid/highlight
  *position*, 0-1 fraction of the `[Lb,Lw]` range, default 0.2/0.5/0.8), `S`/`M`/`H`
  (shadow/mid/highlight *adjustment*, range **-30..30**, default 0/0/0). The curve is
  `identity(x) + S*shad(x) + M*mid(x) + H*high(x)`, where `shad`/`mid`/`high` are smoothstep
  bumps centered at `Ps`/`Pm`/`Ph` — i.e. `S` and `H` are exactly "raise/lower the shadows"
  / "raise/lower the highlights" in the sense this task needs, with no other libvips
  operation needed.
- **LABS band-0 (L) encoding** — confirmed from `libvips/colour/Lab2LabS.c`'s own
  conversion line: `q[0] = CLIP(0, p[0] * (32767.0/100.0), SHRT_MAX)`. So after
  `ToColorSpace(InterpretationLABS)`, band 0 is a signed 16-bit value where **0..32767
  represents logical L 0..100** — meaning `Tonelut`'s `in_max=32767, out_max=32767` lines up
  1:1 with the real data, no extra rescaling needed.
- **`maplut`'s `band` option** — `govips`'s `MaplutOptions` struct (`generated.go:2711`)
  already has a `Band *int` field, but the exported `Maplut(lut *ImageRef) error` wrapper
  (`image_pixel.go:80`) always passes `nil` options, discarding it. libvips' own `maplut.c`
  doc: when `band` is set, only that band of a multi-band input is mapped through a 1-band
  LUT; other bands pass through unchanged, and its `bandfmt_maplut` promotion table confirms
  signed-short (`S`, LABS's band format) is a supported input format. This means the whole
  3-band LABS image can go through `Maplut` directly with `Band: 0` — **no manual
  `ExtractBandToImage`/`BandJoin` round-trip needed**, since that plumbing already exists
  in govips, just not exposed on the `band` argument either.

## Mudanças planeadas (Planned changes)

**Scope of this task**: resolve `V-7` and land `highlights`/`shadows` as real, working P0
params on `image.adjustLight` — Go processor + schema. Preview-shader/editor-UI parity for
the two new params is **out of scope**, tracked as a new `D-xx` (see below), matching how
`TASK-composite-slider-mapping.md`'s original work was sliced into separate schema/Go/
shader/UI task docs.

1. **`workers/internal/govips-fork/vips/tonelut.go`** (new) — a **local, minimal fork** of
   just the `vips` package's missing surface, not the whole `govips` module. Two additions,
   written to match the existing exported-wrapper style exactly (`Sharpen`/`Maplut` in
   `image_pixel.go`):
   - `func Tonelut(opts *TonelutOptions) (*ImageRef, error)` — package-level (no receiver,
     since `tonelut` has no input image), calls the existing unexported `vipsGenTonelut`
     and wraps the result via the existing unexported `newImageRef(out, ImageTypeUnknown,
     ImageTypeUnknown, nil)` (mirrors `NewTransparentCanvas`'s from-scratch construction
     pattern in `image.go`).
   - `func (r *ImageRef) MaplutBand(lut *ImageRef, band int) error` — same body as the
     existing `Maplut`, but passes `&MaplutOptions{Band: &band}` instead of `nil`. (Not
     touching the existing `Maplut` signature — additive, so nothing else in the codebase
     that already calls `Maplut` is affected.)

   Mechanically: copy only `$(go env GOMODCACHE)/github.com/davidbyttow/govips/v2@v2.18.0/vips/`
   (752KB — the actual importable package; **not** the module's `resources/`/`assets/`/
   `examples/` test fixtures, ~150MB combined and irrelevant to a build-only fork) into
   `workers/internal/govips-fork/vips/`, trim its `go.mod` to just the module declaration
   (no test-only deps), add the new file above, and wire it in via a `replace` directive in
   `workers/go.mod`:
   ```
   replace github.com/davidbyttow/govips/v2 => ./internal/govips-fork
   ```
   All existing `vips.XxxFunc` call sites (`resize.go`, `sharpen.go`, `adjust_light.go`,
   etc.) keep importing `github.com/davidbyttow/govips/v2/vips` unchanged — the replace
   directive is transparent to them. `workers/Dockerfile`'s builder stage needs no change:
   it already `COPY`s the full `workers/` tree before `go build`, so the local replace
   target ships with it.

2. **`workers/internal/processors/adjust_light.go`** (edit) — add `highlights`/`shadows`
   params, each `-1.0..1.0` (matching this file's existing `brightness`/`contrast`/
   `blackPoint` range convention, not libvips' native `-30..30`):
   - Applied as a **new LABS-space step** between the existing RGB `Linear1` chain and
     export: `ToColorSpace(InterpretationLABS)` → build one `Tonelut` LUT with `S: &shadows`,
     `H: &highlights` (both scaled by 30, e.g. `shadows*30`) and defaults for everything
     else (`Lb`/`Lw`/`Ps`/`Pm`/`Ph` untouched — the 0/100/0.2/0.5/0.8 libvips defaults) →
     `MaplutBand(lut, 0)` on the LABS image → `ToColorSpace` back to the image's original
     interpretation (read before the LABS conversion) before export.
   - **Sign convention** (a real decision, not invented arbitrarily — stated here for
     review): `shadows` positive = brighter shadows (`S = shadows*30`, same sign — libvips'
     own `S` already means "raise shadows" per its doc). `highlights` positive =
     **recovered/darker** highlights, matching Apple Photos' own Highlights slider
     direction — so `H = -highlights*30` (sign flipped from libvips' raw `H`, which is
     "raise highlights"). If this reads as backwards, worth flagging before landing — the
     rest of the Light params (`exposure`, `brightness`) all have "positive = brighter" so
     `highlights` is deliberately the one exception here, same as it is in Photos/Lightroom.
   - Params stay optional (default `0.0`, no-op) rather than required like the other four —
     unlike `exposure`/`brightness`/`contrast`/`blackPoint`, these are genuinely new fields
     that would otherwise break every recipe/pipeline authored before this task lands, and
     the schema change below matches (`.default(0.0)`, not bare `.number()`).
   - Golden-fixture assertions in `workers/internal/processors/adjust_light_test.go`: extend
     with cases exercising `shadows`/`highlights` on the existing checkerboard/gradient
     fixtures — a measurable property (e.g. mean luminance of the fixture's shadow region
     increases with positive `shadows`), not byte-equality.

3. **`apps/web/src/lib/recipe/schema.ts`** (edit) — `adjustLightParamsSchema` gains
   `highlights: z.number().min(-1.0).max(1.0).default(0.0)` and `shadows: z.number().min(-1.0).max(1.0).default(0.0)`.
   Update the "Deferred params... blocked on V-7" comment to drop `highlights`/`shadows`
   (only `brilliance` remains deferred — no libvips primitive identified for it at all,
   unlike these two).

4. **`docs/90-deferred-register.md`** (edit) — move `V-7` to Resolved with what was found
   and decided (the fork, the sign convention, the LABS encoding). Add a new `D-xx`:
   preview-shader (`apps/web/src/lib/preview/color-math.ts` + both renderers) and editor UI
   (`apps/web/src/app/editor/page.tsx`) do not yet render `highlights`/`shadows` live —
   recipes using them export correctly via Go but preview as a no-op for those two params
   specifically, same shape as how `D-19` tracked the original four params before their own
   shader/UI tasks landed. Also note the fork itself as ongoing maintenance debt: any future
   `govips` upgrade needs this diff manually reapplied (small, ~30 lines, but not automatic).

5. **`workers/go.mod`** (edit) — add the `replace` directive described above. `go.sum`
   unaffected (replace targets bypass the sum check for local filesystem paths).

## Porquê (Why)

`V-7` has sat as the single named blocker on two of the Light composite's seven spec'd
sub-parameters (`docs/plexus-media-pipeline-spec.md`'s P0 editor requirement lists
Highlights/Shadows alongside Exposure/Brightness/Contrast) since `TASK-composite-slider-
mapping.md`. It was left as "add a wrapper or find a newer release" — this session confirmed
no newer release exists, so the remaining path is the fork. The fork's scope turned out
smaller than the original note implied once actually researched: `MaplutOptions.Band`
already exists unused, so no manual `ExtractBandToImage`/`BandJoin` round-trip is needed
either — the whole patch is two small additive functions in one new file, not a deep
libvips-binding project. Doing this now keeps momentum on the composite-slider param
surface (`D-19`) rather than leaving a two-param gap indefinitely, and every number used in
the plan above (LUT domain, LABS band-0 scale, `S`/`H` range) is now pinned to libvips' own
source rather than guessed, per CLAUDE.md §0's "never invent" rule — the previous version of
`V-7` in the register hadn't gone this far.

Preview-shader/editor-UI parity is deliberately **not** in this task's scope: the mapping
formula for a WGSL/GLSL-side `tonelut`-equivalent (the same smoothstep-bump curve, cheap
enough to run per-pixel per-frame) is its own design question, and bundling it here would
repeat the same mistake `D-19`'s note already flags about not over-scoping a single task
doc — better as its own reviewable slice once this Go-side piece is confirmed correct.

## Ficheiros afectados (Affected files)

| File | Change type | Notes |
|------|-------------|-------|
| `workers/internal/govips-fork/vips/` | new (copied) | Local fork of govips's `vips` package only (752KB), copied from the pinned `v2.18.0` module cache; `*_test.go` and `generate.go` deleted |
| `workers/internal/govips-fork/vips/tonelut.go` | new | Adds `Tonelut(opts *TonelutOptions) (*ImageRef, error)` only — `MaplutBand` was tried and reverted, see "Implemented" section |
| `workers/internal/govips-fork/go.mod` | new | Trimmed module file, same module path `github.com/davidbyttow/govips/v2`, only the two real (non-test) transitive deps |
| `workers/go.mod` | edit | Add `replace github.com/davidbyttow/govips/v2 => ./internal/govips-fork` |
| `workers/Dockerfile` | edit | `COPY internal/govips-fork ./internal/govips-fork` before `go mod download` (not in original plan) |
| `workers/internal/processors/adjust_light.go` | edit | Add `highlights`/`shadows` params; LABS `ExtractBandToImage`→`Maplut`→`BandJoin`→`CopyChangingInterpretation` pass |
| `workers/internal/processors/adjust_light_test.go` | edit | Golden-fixture assertions for the two new params (directional + validation + default-omission) |
| `workers/internal/processors/helpers_test.go` | edit | New `writeUniformJPEG` helper (synthetic fixtures — the existing gradient fixture can't exercise `shadows`) |
| `workers/internal/processors/params.go` | edit | New `optionalFloatParamInRange` helper (no float equivalent of `optionalIntParamInRange` existed) |
| `apps/web/src/lib/recipe/schema.ts` | edit | `adjustLightParamsSchema` gains `highlights`/`shadows` (defaulted to 0.0) |
| `apps/web/src/lib/editor/light-blend.ts` | edit | `applyLightBlend`/`identityLightParams` set `highlights: 0, shadows: 0` (type ripple, no behavior change — `D-25`) |
| `apps/web/src/lib/editor/light-blend.test.ts` | edit | Updated expectations for the two new defaulted fields |
| `apps/web/src/lib/recipe/schema.test.ts` | edit | Updated `adjustLightParamsSchema`/round-trip expectations; new boundary/validation tests for `highlights`/`shadows` |
| `apps/web/src/lib/preview/color-math.test.ts` | edit | Literal `AdjustLightParams` construction sites gain `highlights: 0, shadows: 0` (type ripple only) |
| `apps/web/src/lib/preview/drift.test.ts` | edit | Same type-ripple fix for `lightPoints` |
| `apps/web/src/app/preview-demo/page.tsx` | edit | Same type-ripple fix for the demo recipe |
| `docs/90-deferred-register.md` | edit | Resolve `V-7`; add `D-24` (fork maintenance), `D-25` (preview/UI parity gap), `D-26` (Dockerfile change unverified — Docker daemon unavailable) |

---

## Implemented 2026-08-07 — deviations from the plan above

The fork, schema change, and Go processor change all landed largely as planned, with one
real correction found only by testing, not by re-reading the design:

- **`MaplutBand` was removed from the fork.** The original plan called for adding
  `(*ImageRef) MaplutBand(lut *ImageRef, band int) error` and calling it on the whole 3-band
  LABS image with `band=0`. Implemented that way first — it built and passed `go vet`, but
  the golden-fixture tests (`adjust_light_test.go`'s `positive shadows brightens...`/
  `negative highlights brightens...`) failed with the *opposite* direction of the expected
  effect. Root cause, found by reading libvips' `maplut.c` `vips_maplut_build` directly:
  `maplut->out->BandFmt = lut->BandFmt` sets the **entire** output image's band format to
  the LUT's format, not just the mapped band — so the untouched LABS a/b bands (signed
  short, real range ≈-128..127 scaled to -32768..32767) get relabelled as the LUT's
  unsigned short format, and any later consumer reinterprets negative a/b values as huge
  positive ones. Fixed by using the already-exported `ExtractBandToImage` → `Maplut` →
  `BandJoin` → `CopyChangingInterpretation` sequence instead (verified correct via a
  standalone probe before rewriting `adjust_light.go`: base avg 60 → S=30 avg 126 on a
  synthetic dark fixture, matching hand-calculated tonelut math). The fork now only adds
  `Tonelut`; `Maplut` (already exported upstream) is unmodified and reused as-is. The
  `tonelut.go` doc comment in the fork records this finding so a future reader doesn't
  reintroduce the same bug via the tempting one-call `band` option.
- **Fixtures**: `workers/testdata/images/gradient.jpg` (used by every other `adjustLight`
  test) turned out to have an L* range of ~54–62 — entirely on the highlight side of
  tonelut's default midpoint (`Lm=50`), so it can't exercise the `shadows` bump at all
  (`shad(x)=0` for `x≥Lm`). Added `writeUniformJPEG` (`helpers_test.go`) to synthesize small
  solid-color fixtures (dark gray 60/60/60 → L*≈25; light gray 200/200/200 → L*≈81) landing
  solidly in each bump's support range, rather than stretching the existing gradient fixture
  to cover a range it doesn't have.
- **`docs/90-deferred-register.md`**: resolved `V-7`; added `D-24` (fork maintenance),
  `D-25` (preview-shader/editor-UI parity gap, matching `D-19`'s original shape), `D-26`
  (Dockerfile `COPY` ordering fix needed for the local `replace` target, unverified
  end-to-end — same Docker-daemon-unavailable gap as `V-4`).
- **`workers/Dockerfile`**: needed one small change not in the original plan —
  `COPY internal/govips-fork ./internal/govips-fork` before `RUN go mod download`, since a
  local `replace` target must exist on disk at that step (only `go.mod`/`go.sum` were
  copied before). Not verified end-to-end (`D-26`) — local Docker daemon unavailable.

Verified: `go build ./...`, `go vet ./...`, `golangci-lint run ./...`, `go test
./internal/processors/...` (all pass; `internal/dispatch`'s Docker-container tests fail for
the pre-existing, unrelated `V-4` reason — no Docker daemon locally). TS side: `pnpm tsc
--noEmit`, `pnpm lint`, `pnpm test` (89/89) all pass after fixing the ripple from
`highlights`/`shadows` becoming required-with-default fields in `AdjustLightParams`'s
inferred output type (`light-blend.ts`, `light-blend.test.ts`, `schema.test.ts`,
`color-math.test.ts`, `drift.test.ts`, `preview-demo/page.tsx` — all mechanical, no
behavior change: preview/UI still treat `highlights`/`shadows` as 0/no-op, per `D-25`).
