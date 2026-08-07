# TASK-composite-slider-mapping — Light/Color/B&W/Sharpen → recipe parameters (Phase 2)

## Cenário actual

The Edit Recipe schema (`apps/web/src/lib/recipe/schema.ts`, `TASK-recipe-schema.md`)
covers exactly three processors: `image.resize`, `image.convert`, `image.compress`. None
of them is a tone/color adjustment. The spec's own vocabulary for the editor's primary
surface — "a small set of smart sliders (Light, Color, B&W, Sharpen — Apple's vocabulary,
not Lightroom's) that each move several underlying recipe parameters together"
(`docs/plexus-media-pipeline-spec.md` line 65) — has no backing parameters at all yet.
This is tracked as open question `D-6` in `docs/90-deferred-register.md`: "needs its own
small design pass before implementation."

The preview renderer (`TASK-preview-renderer.md`) already ran into this and explicitly
scoped composite sliders out, noting "they need new processor ids/params that don't exist
in the Go workers." No Go processor, no recipe schema entry, no shader exists for any of
Light/Color/B&W/Sharpen today — this task is the design pass that has to exist before any
of those three (schema, Go processor, shader) get built.

## Mudanças planeadas

This task decides **which raw parameters back each composite slider and how each maps to
a concrete, verifiable Go operation** (govips, since that's what `workers/internal/processors/`
already uses for `image.resize`/`image.convert`/`image.compress`). It does **not** decide
the curated composite-slider-to-raw-parameter blend ratios (see "Explicitly out of scope"
below), implement the Go processors, or touch the preview shaders. Those are follow-on
tasks unblocked by this one.

### Grounding, not invention

Per CLAUDE.md §0 ("never invent an API, protocol detail, codec behaviour"), the mapping
below is checked against two primary sources rather than assumed from training data:

- **What each Apple Photos slider actually adjusts** — Apple's own support pages
  ([Adjust light, exposure, and color in a photo or video on Mac](https://support.apple.com/guide/photos/adjust-light-exposure-and-color-pht806aea6a6/mac),
  checked 2026-08-07). Confirmed grouping:
  - **Light**: Brilliance, Exposure, Highlights, Shadows, Brightness, Contrast, Black Point.
  - **Color**: Saturation, Vibrance, Cast.
  - **B&W** (separate section, not "Color" with saturation at zero): Intensity, Neutrals,
    Tone, Grain.
  - **Sharpen** (its own pane, per [Sharpen a photo or video on Mac](https://support.apple.com/guide/photos/sharpen-a-photo-phtba5e3cf7d/mac)):
    Intensity, Edges, Falloff.

  This corrects an assumption I would otherwise have gotten wrong from memory: Color's
  third slider is **Cast** (white-balance/color-cast correction), not "Warmth/Tint" as
  Lightroom names it — confirmed against the primary source instead of asserted.

- **What govips (the binding `workers/` already uses) can actually do** — read directly
  from `github.com/davidbyttow/govips` source (`vips/image_color.go`, `vips/image_pixel.go`,
  `vips/image_transform.go`, `vips/generated.go`) at `master`, checked 2026-08-07:
  - `Modulate(brightness, saturation, hue float64) error` — converts to LCH, applies
    `Linear`, converts back. Exact match for **Saturation**.
  - `Gamma(gamma float64)`, `Linear(a, b []float64)`, `Linear1(a, b float64)` — generic
    multiply-add / power transforms. Sufficient for **Exposure, Brightness, Contrast,
    Black Point** (formulas below).
  - `Sharpen(sigma, x1, m2 float64)` — unsharp mask. Usable for **Sharpen: Intensity**, not
    a clean match for **Edges/Falloff** (see deferred list).
  - `Recomb(matrix [][]float64)` — per-pixel band matrix multiply. Usable for **B&W:
    Neutrals** (a weighted-channel grayscale mix, the same primitive Photoshop's B&W mixer
    and `ffmpeg`'s `colorchannelmixer` both use).
  - **Gap found, not assumed**: `vips/generated.go` contains internal `vipsGenTonelut` and
    `vipsGenHistLocal` (confirming libvips itself has `tonelut`/`hist_local`), but neither
    has a public `(*ImageRef)` wrapper anywhere in the repo (only `Maplut`, `Sharpen`, and
    `Recomb` are exported from the generated set). libvips' own maintainers' recommended
    approach for shadows/highlights recovery ([GitHub discussion #4036](https://github.com/libvips/libvips/discussions/4036))
    is specifically a `tonelut` → `maplut` pipeline on the L channel in LABS space. Without
    an exported `Tonelut` wrapper, **Highlights** and **Shadows** are not implementable
    today without first adding one — this is new `V-7` below, not a silent gap.
  - No govips primitive was found for **Vibrance** (a nonlinear, saturation-dependent
    boost — distinct from `Modulate`'s uniform saturation), **Cast** (grey-world/white-balance
    correction), or **Grain** (noise synthesis). New `V-8` below — unresearched, not "no."

### Processor decision

Four new processor ids, one per Apple grouping (not one grab-bag `image.adjust`) — mirrors
how `image.resize`/`image.convert`/`image.compress` are already separate ids, and lets a
YAML pipeline author write `image.sharpen` without dragging in unrelated Light/Color
fields:

| Processor id | P0 params (this task defines + schemas) | Deferred params (tracked, not schema'd yet) |
|---|---|---|
| `image.adjustLight` | `exposure`, `brightness`, `contrast`, `blackPoint` | `brilliance`, `highlights`, `shadows` (blocked on `V-7`) |
| `image.adjustColor` | `saturation` | `vibrance`, `cast` (blocked on `V-8`) |
| `image.blackAndWhite` | `intensity`, `neutrals`, `tone` | `grain` (blocked on `V-8`) |
| `image.sharpen` | `intensity` | `edges`, `falloff` (no clean govips primitive found) |

Deferred params are **not** added to the Zod schema as optional/no-op fields — an
unimplemented field with no backing Go processor is a lie the schema would be telling
(nothing would read it). They get added when their Go implementation lands, per CLAUDE.md's
"no half-finished implementations."

`image.blackAndWhite` is just another recipe step, applied after `image.adjustColor` when
present — recipe steps are already a linear ordered stack (`recipeSchema.steps`), so
"B&W overrides color" needs no special-casing: a recipe either contains the step or doesn't.

### Parameter ranges and Go-side formulas (P0 only)

All ranges are normalized floats so the same numbers drive both the WebGPU/WebGL2 shader
uniform and the Go call — consistent with how `image.resize`'s `fit` enum is shared today.
Formulas are standard image-processing math (multiply-add / power curves), not govips- or
libvips-specific claims, so they're stated directly rather than `[VERIFY]`-tagged; what
*is* unverified is their exact numeric behavior once actually run through `Linear1`/`Gamma`
end to end — that's `V-2`'s existing "measure drift per control" mandate, inherited here,
not re-litigated.

| Param | Range | Go formula (govips) |
|---|---|---|
| `exposure` | −3.0 … 3.0 (EV stops) | `img.Linear1(math.Pow(2, exposure), 0)` |
| `brightness` | −1.0 … 1.0 | `img.Linear1(1, brightness*255)` |
| `contrast` | −1.0 … 1.0 | `img.Linear1(1+contrast, -128*contrast)` |
| `blackPoint` | 0.0 … 1.0 (fraction remapped to black) | `img.Linear1(1/(1-blackPoint), -blackPoint/(1-blackPoint)*255)` |
| `saturation` | −1.0 … 1.0 | `img.Modulate(1, 1+saturation, 0)` |
| `intensity` (B&W) | 0.0 … 1.0 (blend original↔grayscale) | grayscale via `img.ToColorSpace(vips.InterpretationBW)`, then linear-blend with original by `intensity` |
| `neutrals` | −1.0 … 1.0 (channel-mix skew) | `img.Recomb(matrix)` — matrix rows derived from a base equal-weight `[0.33,0.33,0.33]` mix skewed by `neutrals` toward/away from green (needs empirical tuning against real photos, not a closed-form value — flagged, not invented) |
| `tone` (B&W) | −1.0 … 1.0 | same `Linear1` contrast formula as `contrast` above, applied post-grayscale |
| `intensity` (Sharpen) | 0.0 … 1.0 | `img.Sharpen(0.5, 2, 3*intensity)` — `sigma=0.5, x1=2` fixed at libvips' own documented screen-output defaults ([`Vips.Image.sharpen` docs](https://www.libvips.org/API/8.17/method.Image.sharpen.html)), only `m2` (jaggy-area slope) scales with the slider |

`neutrals`' exact matrix coefficients and all deferred (`V-7`/`V-8`-blocked) params still
need real design work — this task establishes the shape and the P0 subset, not a finished
spec for every slider.

### Explicitly out of scope

- **Composite-slider → raw-parameter blend ratios** (e.g. how much `exposure` moves per
  unit of dragging the single top-level "Light" slider). This is a visual-tuning question
  — answered by dragging a slider against real photos and eyeballing the curve, the kind of
  judgment call CLAUDE.md §0 already says not to fake with false numeric precision in a
  backend design doc. It's editor-UI-only (never leaves the browser as a "Light" value —
  the recipe only ever stores the raw params above), so it belongs in whichever task builds
  the actual composite slider component, tuned against real images at that point.
- Go processor implementation (`workers/internal/processors/adjust_light.go` etc.) — new
  task, unblocked by this one.
- WebGPU/WebGL2 shader implementation and the `V-2`/`V-6`-style preview/export drift
  measurement per control — new task, after the Go processor exists (ground truth has to
  exist before drift against it can be measured).
- `V-7` (Tonelut wrapper), `V-8` (Vibrance/Cast/Grain) — research spikes of their own, not
  resolved here.

## Porquê

The spec treats curated composite controls as load-bearing to the "feels like Apple
Photos" goal (`docs/plexus-media-pipeline-spec.md` line 65, P0 requirement line 132) and
explicitly calls out that the mapping "needs its own small design pass before
implementation" (line 182) — this is that pass. Grounding it against Apple's actual
documented sliders (rather than Lightroom's differently-named ones, which is the mistake
the spec itself warns against) and against what `govips` can actually do (rather than
assuming libvips exposes every primitive Apple's UI implies) avoids two failure modes this
project's own success metrics exist to catch: shipping a "Light" slider that doesn't match
what Apple Photos users expect, and discovering mid-Go-implementation that a promised
parameter (Highlights, Shadows) has no available binding. Splitting P0 (four groups, ten
params, all backed by a real govips call found in this session) from deferred (blocked on
`V-7`/`V-8`, genuinely unresearched) keeps the schema honest instead of shipping fields
nothing implements yet.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `docs/tasks/TASK-composite-slider-mapping.md` | new | this document |
| `docs/90-deferred-register.md` | edit | resolve `D-6`; add `V-7` (no exported govips `Tonelut`/`HistLocal` wrapper — blocks Highlights/Shadows), `V-8` (Vibrance/Cast/Grain — no govips primitive found, unresearched), `D-19` (deferred sub-params tracked per processor, follow-on Go/shader tasks not yet started) |
| `docs/plexus-media-pipeline-spec.md` | edit | Open Questions line 182 updated to point at this task doc instead of listing the mapping as fully open |
| `apps/web/src/lib/recipe/schema.ts` | **not touched this task** | next task, once this design is reviewed — adds `image.adjustLight`/`image.adjustColor`/`image.blackAndWhite`/`image.sharpen` to `imageProcessorId` and `recipeStepSchema` per the P0 table above |
