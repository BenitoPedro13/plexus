# TASK-vibrance-cast-grain-spike — resolving V-8 (Vibrance/Cast/Grain primitives)

## Cenário actual

`V-8` in `docs/90-deferred-register.md` records that no govips primitive was found for
**Vibrance** (Color composite), **Cast** (Color composite), or **Grain** (B&W composite)
during `TASK-composite-slider-mapping.md` — unlike Saturation (`Modulate`) and the four
Light params (`Linear`/`Linear1`), which mapped cleanly to a single govips call. The search
there wasn't exhaustive (a full API-surface search wasn't done). Consequently:

- `apps/web/src/lib/recipe/schema.ts` explicitly omits all three params (lines 64, 72:
  "Deferred param(s) ... blocked on V-8").
- `workers/internal/processors/adjust_color.go`'s doc comment says the same for
  vibrance/cast; no `image.blackAndWhite` grain handling exists at all.
- No shader, no UI control, nothing downstream can exist until this is resolved.

This task is the exhaustive search V-8 called for, run directly against the full
`github.com/davidbyttow/govips/v2@v2.18.0` source (`/Users/benitopedro/go/pkg/mod/github.com/davidbyttow/govips/v2@v2.18.0`,
not just the ~30% of the package copied into `workers/internal/govips-fork/vips/` for
`D-24`) — `vips/generated.go`, `vips/image_color.go`, `vips/image_pixel.go`,
`vips/operations.go`, `vips/image_composite.go`. It does **not** implement any processor,
schema field, or shader — per the same phasing `TASK-composite-slider-mapping.md`
established (mapping/design pass first, schema/Go/shader/UI as separate follow-on tasks).

## Mudanças planeadas

No files change in this task. Findings, to unblock three separate follow-on task docs:

### Cast — resolved, buildable now, no fork needed

No dedicated white-balance primitive exists (confirmed: `globalbalance` is the only
"balance"-named op in the whole package, and its own doc comment says "global balance an
**image mosaic**" — a multi-tile stitching operation, not single-image white balance; not
applicable). But the classic **grey-world assumption** algorithm is fully buildable from
primitives already present and already used elsewhere in this codebase:

1. `img.Stats()` (`vips/image_pixel.go:286`) or per-band `ExtractBandToImage` +
   `Average()` (`image_pixel.go:91,250`) → per-channel mean (R, G, B).
2. `grayTarget := (meanR + meanG + meanB) / 3`.
3. `img.Linear([]float64{grayTarget/meanR, grayTarget/meanG, grayTarget/meanB}, []float64{0,0,0})`
   (`image_color.go:138` — `Linear` already supports one coefficient per band, unlike
   `Linear1` which `adjust_light.go` uses for single-band cases).

This is a textbook algorithm (not govips- or Apple-specific — the same one used in
`libraw`, OpenCV's `xphoto::grayworld`, etc.), mathematically exact, no `[VERIFY]` needed
for the math itself. What *is* a judgment call, not decided here: the `castStrength`
param's shape — Apple's Photos "Cast" slider was confirmed single-direction (a correction
*amount*, not a bidirectional warm/cool dial) in `TASK-composite-slider-mapping.md`'s
primary-source check, so the natural mapping is `castStrength: 0.0..1.0` blending
`Linear()`-corrected output with the original (`lerp` via `Linear1` on the *difference*, or
two `Multiply`+`Add` passes) — full "1.0" isn't necessarily what "correct" white balance
should look like, and that lerp ratio is UX judgment, not math. Naming note: govips already
has an unrelated `(*ImageRef).Cast(format BandFormat)` method (`image_color.go:165`, numeric
band-format casting, e.g. `uchar`→`float`) — the new processor must not be named anything
that collides with it in Go; `image.adjustColor`'s existing `castStrength` param name (not
just `cast`) already avoids this, worth keeping that discipline in the Go function/variable
names too.

### Vibrance — primitives identified, exact curve is a judgment call (like D-22)

No dedicated primitive, confirmed. But every building block a nonlinear,
saturation-dependent chroma boost needs is present and already exercised by this codebase
(`ModulateHSV`, `image_color.go:57`, already does `ToColorSpace(InterpretationLCH)` for a
*different* purpose):

1. `img.ToColorSpace(vips.InterpretationLCH)` → L, C, H bands.
2. `chroma, _ := img.ExtractBandToImage(1, 1)` (`image_pixel.go:102`).
3. Build the boosted band via `Multiply`/`Add`/`Linear` arithmetic on `chroma` (all present:
   `image_pixel.go:217,228`, `image_color.go:138`) implementing whatever curve is chosen —
   e.g. a `newC = C + k*C*(1 - C/Cmax)` shape (boosts low-chroma pixels more than
   already-saturated ones, which is what distinguishes "vibrance" from `Modulate`'s flat
   saturation multiply).
4. `img.BandJoin(lightness, boostedChroma, hue)` (`image_pixel.go:112`) then
   `ToColorSpace` back to the original interpretation — same round-trip shape
   `adjust_light.go`'s Lab path already uses for highlights/shadows (`D-25`).

**Not resolved here, deliberately**: the exact curve and `Cmax` normalization constant.
Unlike the four Light params (pinned to libvips' own `tonelut.c` source, `V-7`) or Cast's
grey-world math above, there is no single documented-correct "vibrance" formula — Adobe's
own algorithm is proprietary and unpublished, and Apple's is not published either. Treating
any specific curve as "the" formula here would violate CLAUDE.md §0's "never invent ...
write `[VERIFY]` instead." This is the same category of open question as `D-22`'s Light
blend ratios: it needs a real visual feedback loop (drag against real photos, judge the
curve), not a primary source to check against. Recommend folding it into `D-22`'s trigger
rather than inventing a formula now.

### Grain — primitives identified, needs a small `govips-fork` extension (D-24 precedent)

`vips_gaussnoise` ("make a gaussnoise image") is present in govips at the C-binding layer
(`vips/generated.go:1770-1803`, `vipsGenGaussnoise(width, height int, opts *GaussnoiseOptions) (*C.VipsImage, error)`)
but — confirmed by grepping every `vips/image_*.go` file — **has no public `ImageRef`
wrapper anywhere in the package**, unlike every other generator function that backs a
public method. This is the exact same shape of gap `D-24` already hit and solved for
`Tonelut`: a from-scratch generator with no input `*ImageRef` to attach a method to, and
`newImageRef`/`ImageRef.image` both unexported so no external wrapper package can construct
the resulting image either. Resolution is the same as `D-24`: extend
`workers/internal/govips-fork/vips/` with a small wrapper (a free function, e.g.
`vips.NewGaussnoiseImage(width, height int, opts *GaussnoiseOptions) (*ImageRef, error)`,
mirroring `tonelut.go`'s shape) rather than inventing an alternative.

Once that exists, compositing it onto the source image is fully covered by existing,
already-wrapped primitives: `img.Composite(noise, mode, 0, 0)` (`image_composite.go:20`,
`BlendMode` enum at `operations.go:199` includes `Overlay`/`SoftLight`/`Add` — real
Porter-Duff/PDF modes, not invented) after scaling the noise image's contrast/mean toward
neutral gray via `Linear1` so it reads as photographic grain rather than raw statistical
noise.

**Not resolved here, deliberately**: which `BlendMode` and what `intensity → sigma`
mapping actually looks like photographic film grain rather than digital noise is an
aesthetic judgment call, same category as Vibrance's curve above — not decided by any
primary source, needs the same real-photo visual loop as `D-22`.

## Porquê

`V-8` blocked all three remaining P0 Color/B&W sub-params behind one unscoped "no primitive
found" note. Resolving it properly means separating three genuinely different situations
that were previously lumped together:

- **Cast** was never actually blocked on a missing primitive — it's a well-known algorithm
  buildable today from `Stats`/`Linear`, already unblocked.
- **Grain** is blocked on real infrastructure (a `govips-fork` extension), which is
  concrete, scoped work with a direct precedent (`D-24`) already in the codebase — not a
  research question anymore.
- **Vibrance** and Grain's *intensity feel* are blocked on the same kind of subjective,
  visual-feedback-loop judgment call `D-22` already identified for the Light master slider
  — inventing a formula now to make V-8 look "resolved" would be exactly the kind of
  unverified claim CLAUDE.md §0 exists to prevent, and would produce a curve nobody has
  looked at against a real photo.

Splitting V-8 into three independently-triggered items (below) means Cast's Go processor
can be implemented immediately without waiting on the other two, instead of three unrelated
problems continuing to share one blocked status.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| (none) | — | Research-only spike; findings recorded in `docs/90-deferred-register.md` below. Follow-on implementation (Cast's Go processor first, since it's unblocked) gets its own task doc(s), same phasing as `TASK-composite-processors-schema.md`/`-go.md`/`-preview-shaders.md`/`-editor-composite-ui.md` did for the original four. |

## Deferred register updates (same pass, per CLAUDE.md §3.1)

- **`V-8` → Resolved.** Replaced by three narrower items:
  - New `D-27`: Cast is unblocked (grey-world algorithm decided above); only the
    `castStrength` blend-ratio shape is undecided — same category as `D-22`, not a new
    unknown.
  - New `D-28`: Grain needs a `govips-fork` extension for `Gaussnoise` (precedent: `D-24`)
    before any Go processor work starts.
  - New `D-29` (or fold into `D-22` directly): Vibrance's curve and Grain's blend
    mode/intensity mapping are visual judgment calls, not primary-source questions —
    same trigger as `D-22` ("first time a real photo is dragged through `/editor`").
