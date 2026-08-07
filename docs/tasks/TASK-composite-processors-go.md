# TASK-composite-processors-go — Go processors for the four P0 composite params (Phase 2)

## Cenário actual

`workers/internal/processors/registry.go` registers seven processors
(`image.resize`, `image.convert`, `image.compress`, `video.transcode`,
`video.compress`, `audio.extract`, `audio.convert`). `TASK-composite-slider-mapping.md`
(`D-6`, committed `3be3a0c`) designed four more — `image.adjustLight`,
`image.adjustColor`, `image.blackAndWhite`, `image.sharpen` — with a P0 param
subset mapped to concrete govips calls, and `TASK-composite-processors-schema.md`
(committed `bfcae66`) encoded that shape into `apps/web/src/lib/recipe/schema.ts`.
Neither task touched `workers/`: no Go processor exists for any of the four ids
today, so a recipe step naming one would fail at `processors.Lookup` — this is
`D-19`'s explicit next step ("the four Go processor files... implementing the
P0 formulas... then shader work").

## Mudanças planeadas

Four new processor files under `workers/internal/processors/`, one per id,
following the existing `resize.go`/`compress.go` shape (load, validate
params, mutate via govips, re-export in the original format, `writeOutput`),
plus a shared param helper and registry/doc wiring:

- `workers/internal/processors/params.go`: add `requireFloatParamInRange` —
  the float64 counterpart of the existing `requireIntParamInRange`, needed
  because every P0 composite param is a float (JSON numbers already decode
  as `float64`, same as the existing int helpers' comment notes).

- `workers/internal/processors/adjust_light.go` (new): `AdjustLight`.
  `exposure`/`brightness`/`contrast`/`blackPoint`, each its own
  `img.Linear1(a, b)` call per `TASK-composite-slider-mapping.md`'s table, in
  the table's row order. **Implementation-level fix beyond the mapping doc**:
  its `blackPoint` formula (`1/(1-blackPoint)`) divides by zero at
  `blackPoint=1.0`, which the schema allows inclusive — floors
  `1-blackPoint` at `1e-6` (`blackPointEpsilon`) before dividing. Verified
  empirically (real govips, `gradient.jpg`) that this produces a very
  negative pre-export pixel value that libvips clamps to fully black
  (decoded average `0`) on export, not `NaN`/`Inf`/a crash — the intended
  "blackPoint=1 -> everything black" behavior, just reached by clamping
  instead of an exact closed form.

- `workers/internal/processors/adjust_color.go` (new): `AdjustColor`.
  `saturation` via `img.Modulate(1, 1+saturation, 0)`, exactly as the mapping
  table states.

- `workers/internal/processors/black_and_white.go` (new): `BlackAndWhite`.
  The mapping table lists `intensity`, `neutrals`, and `tone` as three
  separate rows with three different-looking formulas (`ToColorSpace(BW)`
  for intensity's grayscale, `Recomb(matrix)` for neutrals, `Linear1`
  contrast for tone) — composing them literally as written would grayscale
  twice. This task folds them into one coherent pipeline (a decision left
  open by the mapping doc, which explicitly scoped Go composition to "a new
  task, unblocked by this one"):
  1. `grayscaleMatrix(neutrals)` builds a 3x3 `Recomb` matrix whose three
     output rows are all the same `[r, g, b]` weight vector — every output
     band becomes the same weighted mix of input R/G/B, i.e. a true
     grayscale (R=G=B) image directly, with `neutrals` skewing weight
     toward/away from green exactly as the mapping table describes. This
     replaces the separate `ToColorSpace(BW)` step the intensity row
     mentioned — neutrals controls how "gray" gets computed, so there's only
     one grayscale operation, not two.
  2. `tone`'s contrast formula (`Linear1(1+tone, -128*tone)`, same shape as
     Light's `contrast`) applies to that grayscale layer — "applied
     post-grayscale" per the table.
  3. `intensity` blends the tone-adjusted grayscale layer back with the
     original via `img.Linear1(1-intensity, 0)` / `gray.Linear1(intensity, 0)`
     / `img.Add(gray)` — confirmed empirically (real govips) this reproduces
     the mapping table's "linear-blend original<->grayscale" for the 3-band
     fixtures in `testdata/images/`, and reads as correct by construction for
     a 4th (alpha) band too: `Recomb` auto-expands its matrix with an
     identity row/column when `Bands()==4` (read from
     `govips/v2@v2.18.0/vips/image_transform.go`), so the grayscale layer's
     alpha always equals the original's, and `Linear1`'s scalar applies
     uniformly across every band — algebraically,
     `alpha*(1-intensity) + alpha*intensity == alpha`. Not measured against
     an actual alpha fixture (this package's two fixtures are both opaque);
     flagged, not asserted as tested.

- `workers/internal/processors/sharpen.go` (new): `Sharpen`. `intensity` via
  `img.Sharpen(0.5, 2, 3*intensity)`, sigma/x1 fixed exactly as the mapping
  table specifies.

- `workers/internal/processors/registry.go`: register all four ids; extend
  the package doc comment to mention the Phase 2 composite processors and
  point at `TASK-composite-slider-mapping.md`.

- Tests (`adjust_light_test.go`, `adjust_color_test.go`,
  `black_and_white_test.go`, `sharpen_test.go`, new; `registry_test.go`,
  `helpers_test.go`, edited): golden-fixture assertions on measurable
  properties per CLAUDE.md's Tests section, not exact pixel values (a
  JPEG/PNG re-encode round-trip makes exact predicted floats brittle) —
  directional checks (`imageAverage` brighter/darker, `channelSpread`
  more/less saturated) plus the boundary cases that *are* exact
  (`saturation=-1` / `intensity=1` -> spread `0`; `blackPoint=1.0` -> average
  `0`), dimension/format preservation, and param validation (missing,
  out-of-range) for every param on every processor. `Sharpen` is the
  exception: `gradient.jpg`/`gradient.png` are smooth linear gradients with
  no edges, and unsharp-masking a smooth gradient produced byte-identical
  output at `intensity=0` vs `intensity=1` in direct verification — there is
  no effect on these fixtures to assert against, so `sharpen_test.go` only
  covers format/dimension preservation and validation. New `V-9` below
  tracks needing an edges fixture to actually test Sharpen's effect.

Every formula and API signature above was checked against the real
`govips/v2@v2.18.0` source and against a running libvips 8.18.5 (this
machine has both) before being written, not assumed — `go doc` for every
method signature used, direct reads of `Recomb`'s band-handling in
`image_transform.go`, and small throwaway `go run` programs against the
committed fixtures to confirm actual numeric behavior (blend math, the
blackPoint clamp's export-time behavior, which pixel/average deltas are
real) before committing to the test assertions above.

Not changed: the WebGPU/WebGL2 shaders, the orchestrator's
`BUILTIN_PROCESSORS` (still Phase 3 per `D-17`/the schema task), composite
slider UI blend-ratio tuning (still visual-tuning work, out of scope per the
mapping task).

## Porquê

`D-19` names this as the explicit next step, and it's the piece that turns
the schema slice into something a job can actually execute — before this,
`processors.Lookup` would return `ok=false` for all four new ids and any
recipe using them would fail at dispatch. Doing the Go implementation now
(rather than jumping to shaders) matches the mapping task's own
dependency order: shader/preview drift measurement (`V-2`) needs a Go ground
truth to measure drift against, so the Go side has to exist first. Composing
the B&W processor's three params into one pipeline (rather than three
independent operations that would double-grayscale) is a real design
decision the mapping doc explicitly deferred to this task; doing it via a
single uniform-row `Recomb` matrix is simpler than a `ToColorSpace(BW)` +
`Recomb` combination and was verified to produce identical grayscale
behavior at `neutrals=0`. The `blackPoint` divide-by-zero guard is a small,
necessary correctness fix the mapping doc's formula didn't anticipate
(schema allows the boundary value; the naive formula doesn't) — resolving it
with a numerical clamp (verified against real export/decode behavior) rather
than silently narrowing the schema's range keeps the two in sync without a
cross-repo schema change for a one-line Go guard.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `docs/tasks/TASK-composite-processors-go.md` | new | this document |
| `workers/internal/processors/params.go` | edit | add `requireFloatParamInRange` |
| `workers/internal/processors/adjust_light.go` | new | `AdjustLight`: exposure/brightness/contrast/blackPoint |
| `workers/internal/processors/adjust_color.go` | new | `AdjustColor`: saturation |
| `workers/internal/processors/black_and_white.go` | new | `BlackAndWhite`: intensity/neutrals/tone, composed pipeline |
| `workers/internal/processors/sharpen.go` | new | `Sharpen`: intensity |
| `workers/internal/processors/registry.go` | edit | register the four new ids; update package doc comment |
| `workers/internal/processors/registry_test.go` | edit | assert the four new ids are registered |
| `workers/internal/processors/helpers_test.go` | edit | add `imageAverage`/`channelSpread` shared test helpers |
| `workers/internal/processors/adjust_light_test.go` | new | directional + boundary + validation tests |
| `workers/internal/processors/adjust_color_test.go` | new | directional + boundary + validation tests |
| `workers/internal/processors/black_and_white_test.go` | new | directional + boundary + validation tests |
| `workers/internal/processors/sharpen_test.go` | new | format/dimension + validation tests only (see Mudanças) |
| `docs/90-deferred-register.md` | edit | update `D-19` (Go processors done, shaders/blend-ratio remain); add `V-9` (no edges fixture to test Sharpen's actual effect) |
