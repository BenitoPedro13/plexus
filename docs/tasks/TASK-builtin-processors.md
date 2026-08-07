# TASK-builtin-processors — Real image processors for the Go worker (Phase 1, slice 3)

## Cenário actual

`workers/internal/dispatch/handler.go`'s `Handle()` is an explicit stub (its own doc
comment says so): it unmarshals the `StepDispatchMessage`, ignores `Processor` and
`Params` entirely, and always publishes `StepResultComplete` with
`OutputRef = in.InputRef` — i.e. every job "succeeds" without touching the file at
`InputRef` at all. No image library is wired in; `workers/go.mod` has no image-processing
dependency, only `nats.go` and `testcontainers-go`.

On the orchestrator side, `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts`
already reserves exactly three Phase-1 processor ids —
`BUILTIN_PROCESSORS = ['image.resize', 'image.convert', 'image.compress']` — and accepts
free-form `params: Record<string, unknown>` per step with no per-processor shape
validation. `CreateJobDto.inputRef` is a bare opaque string (comment: "see D-3 in the
deferred register" — no object storage exists yet). The failure path is already fully
wired end-to-end and unexercised by anything except the never-failing stub:
`apps/orchestrator/src/jobs/job-result-handler.ts` already transitions a job step to
`FAILED` and the parent job to `FAILED` when it receives
`StepResultMessage.status === 'failed'`.

`libvips` is not installed on this machine (`pkg-config --modversion vips` fails,
`vipsheader` not on `PATH`); `ffmpeg`/`ffprobe` are (Homebrew, `/opt/homebrew/bin`). No Go
image-processing library is imported anywhere. There is no `workers/README.md`, no CI
workflow (`.github/` doesn't exist), and no `Dockerfile` for the worker — it only runs via
`go run`/`go test` against the local toolchain, so this task's only environment
prerequisite is this machine (and, later, whatever CI/deploy image gets built).

## Mudanças planeadas

**Scope for this slice**: real execution of exactly the three processor ids the
orchestrator already reserves — `image.resize`, `image.convert`, `image.compress` — via
libvips. Video/audio processors (ffmpeg) are P0 per the spec but not part of Phase 1's
phasing line ("Built-in processors: resize, convert, compress"); deferred explicitly, see
Porquê.

### Library choice: govips v2 (`github.com/davidbyttow/govips/v2/vips`)

Verified against the project's own README (2026-08-06): actively maintained (last
published March 2026), requires **libvips 8.14+** and **Go 1.23+** (this repo is on
1.26.5, satisfied), cgo + a C compiler. Install on macOS:
`brew install vips pkg-config` + `export CGO_CFLAGS_ALLOW="-Xpreprocessor"`. This is a new
build-time system dependency — not vendored, not optional. Documented in a new
`workers/README.md` "Prerequisites" section (see Affected files). No CI exists yet to
update; tracked as new debt below.

### `workers/internal/processors/` (new package)

- **`registry.go`** — `type Func func(ctx context.Context, inputRef string, params map[string]interface{}) (outputRef string, err error)` and `var registry = map[string]Func{...}`; `Lookup(name string) (Func, bool)`.
- **`vips_lifecycle.go`** — `Startup()`/`Shutdown()` wrapping `vips.Startup(nil)` /
  `vips.Shutdown()`, called once from `cmd/worker/main.go`, not per-job (govips's own
  guidance: initialize once, the library is safe for concurrent use after that).
- **`output.go`** — shared helper `writeOutput(dir, jobStepID string, ext string, data []byte) (path string, err error)`: writes to `<WORKER_STORAGE_DIR>/<jobStepId>.<ext>` and returns that path. `WORKER_STORAGE_DIR` is a new env var (default `./data/worker-output` for local dev, must exist or be created with `os.MkdirAll`).
- **`resize.go`** — `image.resize`. Params: `{"width": number, "height": number, "fit": "inside"|"cover"}` — **both `width` and `height` are required** (see Porquê for why single-dimension resize is explicitly out of scope, not silently unsupported). `fit` optional, default `"inside"`. Maps to `image.Thumbnail(width, height, crop)` where `fit=inside` → `vips.InterestingNone` (scale to fit within box, preserves full frame, no crop) and `fit=cover` → `vips.InterestingCentre` (crop-to-fill). Missing/non-positive width or height, or an unrecognized `fit` value, is a validation error → processor returns `err`, not a panic. Output re-encoded in the *original* format (`img.OriginalFormat()`) at that format's default export params — resize doesn't change format, only pixels.
- **`convert.go`** — `image.convert`. Params: `{"format": "jpeg"|"png"|"webp"|"avif", "quality": number}` (quality optional, 1–100, default 85; ignored for `png`, which has no lossy quality knob). `format` is required and validated against exactly those four — the four the spec's editor/pipeline examples actually need, not govips's full export surface (gif/tiff/heif/jp2k/jxl/magick are unused code paths nothing calls, so left out per CLAUDE.md §"no code for hypothetical requirements"). Switches on `format` to the matching `Export*` call.
- **`compress.go`** — `image.compress`. Params: `{"quality": number}` (required, 1–100). Loads the image, reads `OriginalFormat()`, and re-exports **in that same format** at the requested quality — compress never changes format (that's `convert`'s job). Supported original formats: jpeg, png, webp, avif (same four as convert); anything else (e.g. bmp, tiff, gif) is a validation error, not a silent no-op. For PNG (no `Quality` field, only `Compression int` 0–9, where *lower* means less compression/larger file — opposite direction from "quality"), map `quality` linearly: `compression = 9 - round(quality/100*9)`, clamped to `[0,9]`. This mapping is a judgment call, not a governed spec, so it's called out explicitly here rather than left implicit in code — a future task can replace it once "recipe fidelity" style numeric bounds matter for compression too (that's an editor/Phase-2 concern, not this one).

### `workers/internal/dispatch/handler.go` (edit)

Replace the always-succeeds stub body: after unmarshalling, `processors.Lookup(in.Processor)`;
unknown processor id → build a `StepResultMessage{Status: StepResultFailed, Error: "unknown processor: "+in.Processor}` (not a `Term()` — this is a valid message the orchestrator sent, not malformed JSON, so it must produce a normal failed-job result, not silently vanish). Found processor → call it with `in.InputRef`/`in.Params`; on error, `StepResultFailed` with `err.Error()`; on success, `StepResultComplete` with the returned `outputRef`. The existing unparsable-JSON `Term()` path is unchanged. This keeps `Handle()` itself thin — it's transport/result-shape glue, same as slice 2 — with all image logic in `processors/`.

### `workers/cmd/worker/main.go` (edit)

Call `processors.Startup()` right after flag/env parsing, before the consumer loop starts;
`defer processors.Shutdown()`.

### `workers/testdata/images/` (new, committed fixtures)

A handful of small real image files per CLAUDE.md's golden-fixture rule (assert
dimensions/format/size bounds, not byte-equality — libvips encoders aren't guaranteed
deterministic across runs/versions): one small JPEG, one small PNG (kept under ~20KB each
so they're cheap to commit — e.g. a synthetic gradient or solid-color test pattern
generated once and checked in, not a real photo).

### Tests

- `workers/internal/processors/*_test.go` — one table per processor: resize
  inside/cover, convert to each of the four formats, compress at a couple of quality
  levels, plus the explicit failure cases (missing width/height, bad fit value,
  unsupported compress format, unknown convert format). Assertions via
  `vips.NewImageFromFile(outputRef)` on the *output* — width/height/format — not
  byte-equality.
- `workers/internal/dispatch/handler_test.go` (extends existing dispatch test file) —
  end-to-end: publish a real `StepDispatchMessage` pointing at a fixture, consume it
  through `Handle()` against real NATS (testcontainers, per CLAUDE.md's no-mocking rule),
  assert the published `StepResultMessage` and that the output file actually exists and
  has the expected properties. Also covers the two failure paths (unknown processor,
  processor validation error) producing `StepResultFailed`, not a silently-dropped
  message — this is the one behavior this slice changes that the orchestrator side has
  been ready for since slice 2 but nothing has ever exercised.

## Porquê

Phase 1 (spec "Suggested Phasing") is explicitly "Orchestrator + single Go worker type +
Postgres + NATS. Linear pipelines only. Built-in processors: resize, convert, compress" —
slice 2 built the transport (dispatch/result loop, no-lost-jobs guarantee); this slice is
the last piece needed for Phase 1 to be actually demoable end-to-end: submit a real image,
watch a real resize/convert/compress run, get a real output file back. Without it, every
prior slice's "job succeeded" is meaningless — the stub can't fail, so the state machine's
`FAILED` path (already fully built in `job-result-handler.ts`) has never once executed
against a real signal.

**govips over shelling out to a `vips` CLI binary or hand-rolling with `image/jpeg` /
`image/png` stdlib codecs**: the spec is explicit that "media operations go through
ffmpeg/libvips, never hand-rolled" (CLAUDE.md §2.1) and names libvips specifically for
image ops in the architecture table. A CLI-shelling approach (`exec.Command("vips", ...)`)
would avoid the cgo/build-time dependency but reintroduces the class of bug ffmpeg/libvips
binding exists to prevent — parsing stdout/stderr instead of a typed API, no compile-time
guarantee the flags a Go string built. govips's own docs (verified live, not from
training-data memory, per CLAUDE.md §2.0) confirm it's still the actively maintained
canonical Go/libvips binding, so it's the tool, not a rewrite candidate.

**Both `width` and `height` required for `image.resize`, no single-dimension "scale by
width, preserve aspect" mode in this slice**: govips's `Thumbnail`/`ThumbnailWithSize`
API takes both dimensions; achieving "resize by width only" idiomatically means passing an
artificially huge value for the unconstrained dimension, which is a real but *unverified*
pattern for this specific library version — CLAUDE.md §0 says never invent library
behavior. Rather than guess or ship something untested, this slice requires both
dimensions (still covers the P0 "resize" processor and the recipe-DAG example in the
spec, which passes explicit width/height) and single-dimension resize is deferred with a
`[VERIFY]` note, not silently dropped.

**Local-filesystem `inputRef`/`outputRef` instead of object storage**: D-3 (object storage
choice) is explicitly deferred to Phase 3's presigned-upload work and this task doesn't
need to resolve it — `inputRef` is already documented as "opaque" on the DTO. Treating it
as a literal filesystem path the worker reads/writes directly is the minimal stand-in that
lets processors actually run now, and it mirrors the shape the eventual flow will have
(download-to-temp → process → upload-result → return object key) closely enough that
swapping in real MinIO later is a localized change inside `processors/output.go`, not a
redesign of the processor interface.

**PNG's `quality`→`Compression` linear mapping**: PNG's export params have no lossy
"quality" knob (`Compression` 0–9 trades encode time for size at fixed lossless quality,
not visual fidelity), so `image.compress`'s single `quality` param needs *some* mapping to
stay format-agnostic at the call site. This is called out as a judgment call in the plan
rather than hidden in a code comment because it's exactly the kind of place a future
reviewer needs to know a decision was made, not derive it from the formula.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `workers/go.mod` / `workers/go.sum` | edit | add `github.com/davidbyttow/govips/v2` |
| `workers/internal/processors/registry.go` | new | processor id → `Func` lookup |
| `workers/internal/processors/vips_lifecycle.go` | new | `Startup`/`Shutdown` wrapping govips init |
| `workers/internal/processors/output.go` | new | shared output-path helper, `WORKER_STORAGE_DIR` |
| `workers/internal/processors/resize.go` | new | `image.resize` |
| `workers/internal/processors/convert.go` | new | `image.convert` |
| `workers/internal/processors/compress.go` | new | `image.compress` |
| `workers/internal/processors/resize_test.go` | new | golden-fixture table tests |
| `workers/internal/processors/convert_test.go` | new | golden-fixture table tests |
| `workers/internal/processors/compress_test.go` | new | golden-fixture table tests |
| `workers/testdata/images/*.jpg` `*.png` | new | small committed fixtures |
| `workers/internal/dispatch/handler.go` | edit | real dispatch to `processors.Lookup`, unknown-processor and processor-error → `StepResultFailed` |
| `workers/internal/dispatch/handler_test.go` | edit | add real-processing + both failure-path cases |
| `workers/cmd/worker/main.go` | edit | call `processors.Startup()`/`defer Shutdown()` |
| `workers/README.md` | new | libvips prerequisite + install instructions (brew/apt), `WORKER_STORAGE_DIR` env var |
| `.env.example` | edit | add `WORKER_STORAGE_DIR` |
| `docs/90-deferred-register.md` | edit | new `D-11` (local-fs inputRef/outputRef stand-in for object storage), `D-12` (no CI/Dockerfile installs libvips yet — nothing to update now, but the next task that adds either must), `D-13` (single-dimension resize deferred, `[VERIFY]` on the oversized-dimension Thumbnail idiom), `D-14` (video/audio processors via ffmpeg deferred to a follow-up task — P0 per spec but not in Phase 1's phasing line) |
