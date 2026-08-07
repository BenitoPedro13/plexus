# TASK-video-audio-processors — ffmpeg-backed video/audio processors (Phase 1, slice 4)

## Cenário actual

`workers/internal/processors/registry.go` registers exactly three processor ids —
`image.resize`, `image.convert`, `image.compress` — all backed by govips/libvips
(`TASK-builtin-processors.md`, slice 3). `workers/internal/dispatch/handler.go` dispatches
by looking up `in.Processor` in that registry; an unknown id already produces a proper
`StepResultFailed` (built in slice 3, no change needed here — this is the reason this slice
doesn't need to touch `handler.go` at all).

`apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts`'s `BUILTIN_PROCESSORS` only
accepts those same three ids — a pipeline step referencing `video.transcode` or
`audio.extract` today fails orchestrator-side validation (`@IsIn(BUILTIN_PROCESSORS)`)
before a job is ever created, regardless of what the worker could do.

The spec's P0 requirements line (`docs/plexus-media-pipeline-spec.md` "Requirements") reads
"Built-in processors: image resize/convert/compress, **video transcode/compress via
ffmpeg, audio extraction/convert**." `docs/90-deferred-register.md` `D-14` records this gap
explicitly: video/audio was deliberately left out of slice 3 because Phase 1's own phasing
line only names the three image processors, and ffmpeg subprocess wrapping is "a different
implementation shape from govips" deserving its own task doc — this is that task.

No Go module currently shells out to anything; `workers/go.mod` has no ffmpeg binding (none
needed — see Porquê). `ffmpeg`/`ffprobe` 8.1.2 are installed locally via Homebrew
(`/opt/homebrew/bin`, confirmed via `ffmpeg -version` for this task) but nothing in the repo
declares them as a prerequisite yet beyond libvips in `workers/README.md`.

## Mudanças planeadas

**Scope for this slice**: four processor ids — `video.transcode`, `video.compress`,
`audio.extract`, `audio.convert` — closing `D-14`. Each shells out to the `ffmpeg` binary
via `os/exec` (no cgo binding — see Porquê); `ffprobe` is deliberately **not** used (see
Porquê on container detection).

### Library/tool choice: shell out to the `ffmpeg` CLI directly

Verified against the actually-installed binary (`ffmpeg -h encoder=...`, `-muxers`,
`-encoders`), not from memory, per CLAUDE.md §2.0/§0:

- Video: `libx264` for the `mp4` container (`-crf`, range confirmed 0–51 via
  `ffmpeg -h encoder=libx264` + corroborating web sources, default 23), `libvpx-vp9` for
  `webm` (`-crf`, range confirmed 0–63 via `ffmpeg -h encoder=libvpx-vp9`; **VP9 constant-quality
  mode requires `-b:v 0` alongside `-crf`** — without it libvpx ignores `-crf` and falls back to
  its default bitrate-target mode, confirmed via ffmpeg community docs since the official
  trac wiki returned an access-denied page when fetched for this task).
- Audio: `aac` (native encoder, confirmed non-experimental on this ffmpeg build — no
  `-strict` flag needed, verified by running it), `libmp3lame`, `libopus` — all three
  support `-b:a <bits/s>` for CBR/ABR per `ffmpeg-codecs.html` §8.7.1/§8.9.1 (fetched
  directly). `wav` via `pcm_s16le` (lossless, no bitrate knob).
- Confirmed by actually running each encoder against a synthetic `lavfi testsrc`/`sine`
  fixture and probing the output with `ffprobe` — every combination below (mp4/webm video,
  mp3/aac/opus/wav audio) was exercised once by hand before being written into code.

### `workers/internal/processors/ffmpeg.go` (new)

- `runFFmpeg(ctx context.Context, args ...string) error` — prepends
  `-nostdin -hide_banner -loglevel error -y` to `args`, runs
  `exec.CommandContext(ctx, "ffmpeg", fullArgs...)` with `argv` elements (never a shell
  string — no injection surface since `inputRef`/`outputRef`/params-derived flags are all
  passed as separate `argv` entries), captures `stderr` into a buffer, and on non-zero exit
  wraps the captured stderr tail into the returned error.
- `CheckAvailable() error` — `exec.LookPath("ffmpeg")`; called once at worker startup (see
  `main.go` below), not per-job — fail fast if the binary is missing rather than surfacing
  it as a confusing first-job failure.
- `videoCodecsForContainer(container string) (vcodec, acodec string, ok bool)` — the fixed
  table `"mp4" → ("libx264", "aac")`, `"webm" → ("libvpx-vp9", "libopus")`. Any other value
  is `ok=false`. Same "fixed small enum, not the tool's full surface" shape as
  `convert.go`'s `supportedFormats` in slice 3.
- `audioCodecForFormat(format string) (codec string, ok bool)` — `"mp3" → "libmp3lame"`,
  `"aac" → "aac"`, `"opus" → "libopus"`, `"wav" → "pcm_s16le"`.
- `videoCrfArgs(vcodec string, quality int) []string` — quality (1–100) → codec-specific
  CRF flags, same "documented judgment call" shape as slice 3's `pngCompressionFromQuality`:
  - `libx264`: `crf := 51 - (quality*51)/100`, clamped `[0,51]`; returns `["-crf", crf]`.
  - `libvpx-vp9`: `crf := 63 - (quality*63)/100`, clamped `[0,63]`; returns
    `["-crf", crf, "-b:v", "0"]` (the `-b:v 0` is not optional — see above).

### `workers/internal/processors/output.go` (edit)

Extract the path-construction half of `writeOutput` into a new
`outputPath(jobStepID, ext string) (string, error)` (does the `WORKER_STORAGE_DIR` env
lookup + `os.MkdirAll` + `filepath.Join`); `writeOutput` becomes a thin wrapper that calls
`outputPath` then `os.WriteFile`. The ffmpeg-backed processors below call `outputPath`
directly and pass that path to `ffmpeg` as its output argument — ffmpeg writes the file
itself, there's no in-memory `[]byte` to hand to `writeOutput` the way govips's `Export*`
calls produce one.

### `workers/internal/processors/video_transcode.go` (new)

`video.transcode`. Params: `{"format": "mp4"|"webm", "quality": number}` (`quality`
optional 1–100, default 75; ignored fields validated the same way `resize.go` validates
`fit` — inline, not a shared "enum" helper, matching existing style). `format` required,
validated against exactly `mp4`/`webm` via `videoCodecsForContainer`. Builds
`ffmpeg -i <inputRef> -c:v <vcodec> <crf-args> -c:a <acodec> -b:a 128k <outputPath>` (audio
bitrate for transcode is a fixed 128k — not exposed as a param in this slice; the `quality`
param only steers video CRF, mirroring how `image.convert`'s single `quality` param doesn't
split into separate axes either).

### `workers/internal/processors/video_compress.go` (new)

`video.compress`. Params: `{"quality": number}` (required, 1–100). "Compress never changes
format" (same rule as `image.compress`) — container is read from **`filepath.Ext(inputRef)`**,
not content-sniffed via `ffprobe`, deliberately (see Porquê). Must be `.mp4` or `.webm`
(case-insensitive); anything else is a validation error, same shape as `image.compress`'s
unsupported-original-format error. Re-encodes video at the CRF for that container's codec
and audio at a fixed 128k, same codec table as transcode — i.e. compress also normalizes to
the container's standard codec pair, it doesn't attempt to preserve whatever codec the
input actually used (documented explicitly in Porquê, this is the judgment call of this
slice).

### `workers/internal/processors/audio_extract.go` (new)

`audio.extract`. Params: `{"format": "mp3"|"aac"|"opus", "bitrate": number}` (`bitrate`
optional 32–320, default 128). Strips any video/attached-picture streams explicitly —
`-vn -map 0:a:0` — then `-c:a <codec> -b:a <bitrate>k`. Takes a video (or any file with an
audio stream) as `inputRef`, writes an audio-only file. Extension = `format` string, which
is also a valid muxer-selecting extension for all three (`.mp3`, `.aac` → ADTS, `.opus`) —
confirmed by running each once against a synthetic fixture and probing the result's
`codec_name`.

### `workers/internal/processors/audio_convert.go` (new)

`audio.convert`. Params: `{"format": "mp3"|"aac"|"opus"|"wav", "bitrate": number}`
(`bitrate` optional 32–320 default 128, **ignored** for `wav` — no bitrate flag emitted,
same "some formats have no such knob" pattern as `image.convert`'s PNG case). Also emits
`-vn -map 0:a:0` (defensive against embedded cover-art streams in the input, same reasoning
as `audio.extract`).

### `workers/internal/processors/registry.go` (edit)

Add all four new ids to the `registry` map.

### `workers/cmd/worker/main.go` (edit)

Call `processors.CheckAvailable()` right after `processors.Startup()` (libvips), before the
NATS connection — same fail-fast-at-boot pattern, no per-job cost since it's just a `PATH`
lookup once.

### `workers/testdata/media/` (new, committed fixtures)

Three tiny synthetic files generated once via `ffmpeg -f lavfi` (0.5s, 32×32 `testsrc` +
440Hz `sine`, low bitrate) and committed — `tiny.mp4` (~5KB), `tiny.webm` (~4KB),
`tiny.mp3` (~2.5KB, audio-only, for `audio.convert`'s input). Same golden-fixture rule as
slice 3: assert measurable output properties via `ffprobe` (container, codec, has-audio /
has-video), not byte-equality — ffmpeg encoders are non-deterministic across
versions/builds same as libvips.

### Tests

- `workers/internal/processors/video_transcode_test.go`,
  `video_compress_test.go`, `audio_extract_test.go`, `audio_convert_test.go` — table tests
  per processor: each valid format, the CRF/bitrate boundary values, and the explicit
  failure cases (unsupported `format`/container, `quality`/`bitrate` out of range). Assert
  via `ffprobe -show_entries stream=codec_name,codec_type -of json` on the output file.
- `workers/internal/dispatch/handler_test.go` (extend) — one additional end-to-end case
  (e.g. `video.transcode`) through real NATS via testcontainers, to prove the registry
  wiring reaches these new processors the same way it reaches the image ones; per-processor
  logic is already covered by the table tests above, so this isn't duplicated four times.

## Porquê

**Shell out to the `ffmpeg` CLI via `os/exec`, not a cgo/Go ffmpeg binding**: unlike
libvips, there is no actively-maintained idiomatic Go binding for ffmpeg's encode path with
the same standing as govips has for libvips (the common options are either CLI-wrapping
libraries that just build `argv` strings for you — no real abstraction gained — or
low-level cgo bindings to libavcodec/libavformat directly, which is a materially bigger
surface and dependency than this slice needs). The spec's own architecture table already
says workers "shell out to or bind" ffmpeg/libvips (CLAUDE.md §2.1) — shelling out is the
named, sanctioned option for ffmpeg specifically, unlike libvips where govips was chosen
over CLI-shelling in slice 3 precisely because a binding existed and typed the interface.
`os/exec.CommandContext` with an `argv` slice (never a shell-interpolated string) avoids
the injection class that string-built shell commands would risk.

**Fixed codec pairs per container (`mp4`→h264/aac, `webm`→vp9/opus), not a general codec
selector**: same reasoning as slice 3's four fixed image formats — these are the pairs the
spec's examples and P0 line actually need, not ffmpeg's full encoder surface (no h265, av1,
flac, alac — CLAUDE.md's "no code for hypothetical requirements"). If a future task needs
another codec, it's an additive change to `videoCodecsForContainer`/`audioCodecForFormat`,
not a redesign.

**`video.compress` detects its container from `filepath.Ext(inputRef)`, not `ffprobe`
content-sniffing**: verified directly against this ffmpeg build — `ffprobe`'s
`format_name` for an actual `.mp4` file is the comma-joined demuxer name
`"mov,mp4,m4a,3gp,3g2,mj2"`, which is genuinely ambiguous between `.mp4` and plain `.mov` at
the container-family level (both hit the same demuxer). Disambiguating further would mean
parsing the `major_brand`/`compatible_brands` format tags, whose value space (`isom`,
`mp42`, `M4A `, etc.) isn't exhaustively documented and would be inventing a heuristic
CLAUDE.md §0 forbids. Extension-based detection isn't a guess here: this system's own
`outputPath` naming convention (`<jobStepID>.<ext>`) guarantees any file this worker
produced — including a prior pipeline step's `image.convert`/`video.transcode` output that
feeds into a later `video.compress` step — has the format encoded in its extension already.
This is a narrower, explicit judgment call than slice 3's PNG-quality mapping in the same
spirit: called out here rather than left implicit.

**`ffprobe` is not a dependency of this slice at all** despite being installed alongside
`ffmpeg`: once container detection went extension-based, nothing else in this slice's scope
needs to inspect a file's contents before processing — ffmpeg itself produces a clear stderr
message (captured by `runFFmpeg`) if, say, `audio.extract` is pointed at a file with no
audio stream, which becomes the processor's returned error without a separate pre-check.
Adding a probe step purely for pre-validation the tool already gives you for free would be
exactly the kind of hand-rolled validation CLAUDE.md §2 argues against.

**VP9's `-b:v 0` requirement is called out explicitly rather than left as a "just works" CRF
flag**: this is the one place in this slice where the canonical source (ffmpeg's own trac
wiki) was unreachable when fetched for this task (an access-denied/bot-challenge page, not a
404 — plausibly transient) and the claim instead rests on corroborating secondary sources
plus the local `ffmpeg -h encoder=libvpx-vp9` output, which confirms the flag's existence
and range but not the "required for CRF mode to activate" behavior by itself. Tracked as a
new `V-xx` below rather than treated as fully verified.

**Quality→CRF linear mapping, same shape as slice 3's PNG-compression mapping**: x264 and
VP9's CRF scales aren't equivalent (0–51 vs 0–63, and "23 as a good default" is specific to
x264 — VP9's own commonly-cited default is closer to 31), so a single `quality` param needs
a per-codec formula, not a shared constant. Documented here rather than buried in the
formula, same rule as before.

**`video.transcode`/`video.compress` re-encode audio at a fixed 128k with no `bitrate`
param**, while `audio.extract`/`audio.convert` expose one: video processors' `quality`
param already governs one axis (video CRF) mirroring `image.convert`'s single-param shape;
adding a second independent audio-bitrate axis to the video processors' param surface is
more control than the spec's P0 examples call for. Audio-native processors expose it because
audio quality *is* the entire output for those two.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `workers/internal/processors/ffmpeg.go` | new | `runFFmpeg`, `CheckAvailable`, codec tables, CRF mapping |
| `workers/internal/processors/output.go` | edit | extract `outputPath()` from `writeOutput()` for reuse by ffmpeg-writes-directly processors |
| `workers/internal/processors/video_transcode.go` | new | `video.transcode` |
| `workers/internal/processors/video_compress.go` | new | `video.compress` |
| `workers/internal/processors/audio_extract.go` | new | `audio.extract` |
| `workers/internal/processors/audio_convert.go` | new | `audio.convert` |
| `workers/internal/processors/registry.go` | edit | register the four new ids |
| `workers/internal/processors/video_transcode_test.go` | new | golden-fixture table tests |
| `workers/internal/processors/video_compress_test.go` | new | golden-fixture table tests |
| `workers/internal/processors/audio_extract_test.go` | new | golden-fixture table tests |
| `workers/internal/processors/audio_convert_test.go` | new | golden-fixture table tests |
| `workers/testdata/media/tiny.mp4` `tiny.webm` `tiny.mp3` | new | small committed fixtures |
| `workers/cmd/worker/main.go` | edit | call `processors.CheckAvailable()` at startup |
| `workers/internal/dispatch/handler_test.go` | edit | one end-to-end case through a new processor |
| `apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts` | edit | add `video.transcode`, `video.compress`, `audio.extract`, `audio.convert` to `BUILTIN_PROCESSORS` |
| `workers/README.md` | edit | add ffmpeg/ffprobe prerequisite section |
| `docs/90-deferred-register.md` | edit | resolve `D-14`; add new `V-3` (VP9 `-b:v 0` CRF-activation behavior sourced from secondary docs, trac wiki unreachable); add new `D-15` (fixed codec pairs only — h265/av1/flac/alac deferred); note extended on `D-12` (ffmpeg is now also an uninstalled-in-CI/Dockerfile prerequisite, not just libvips) |
