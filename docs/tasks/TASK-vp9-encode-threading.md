# TASK: Fix single-threaded VP9 encode in video.transcode/video.compress

## Cenário actual

`video.transcode` (to `webm`) and `video.compress` (on a `.webm` input) both go
through `workers/internal/processors/ffmpeg.go`'s `videoCrfArgs("libvpx-vp9", quality)`,
which today returns only `-crf <n> -b:v 0`. Neither call site sets `-row-mt`,
`-tile-columns`, or `-threads`.

Reported symptom: converting a 24s, 3420×1972 screen recording
(`Screen Recording 2026-08-04 at 16.23.08.mov`, h264/aac) to WebM through the app
took 13 minutes for a single job step.

Reproduced directly with the same ffmpeg args the worker issues today, on an
idle 8-core machine:

```
ffmpeg -i in.mov -c:v libvpx-vp9 -crf 22 -b:v 0 -c:a libopus -b:a 128k out.webm
```

→ **5m12s–5m52s wall clock, 233–245% CPU** (repeated 3x for consistency).

Root cause, confirmed against `ffmpeg -h encoder=libvpx-vp9` (the installed
binary's own option docs, ffmpeg 8.1.2/libvpx):

- `-row-mt` (row-based multithreading) defaults to `auto`, which in practice
  resolves to off — libvpx-vp9's `Threading capabilities` line reports `other`,
  meaning ffmpeg's generic frame-threading doesn't apply to it; row-mt is the
  encoder-specific knob that does. Without it, one physical CPU core does
  essentially all of the encode work regardless of how many cores the host has
  (confirmed: CPU% stayed ~230-245% across three runs on an 8-core machine —
  consistent with 1 encode thread + demux/audio/mux overhead, not with 8 cores
  being available).
- `-tile-columns` (log2 tile-column count) defaults to `-1` (auto/unset) and is
  the second lever for parallelizing a single frame's encode across cores,
  particularly valuable at high resolution (this input is ~4K-class).
- `-cpu-used` is *not* part of this bug — ffmpeg's own default for it is `1`
  (`ffmpeg -h encoder=libvpx-vp9` → `-cpu-used <int> ... (default 1)`), which
  the code already inherits by not overriding it. `-cpu-used` is a genuine
  quality/size-vs-speed trade (see Porquê) and is out of scope for this fix.

`VideoTranscode` (`video_transcode.go`) and `VideoCompress` (`video_compress.go`)
are unaffected for the `mp4`/h264 path — `libx264` auto-detects and uses all
available cores by default, which is why only the VP9 path is broken.

## Mudanças planeadas

- **`workers/internal/processors/ffmpeg.go`**
  - Rename `videoCrfArgs` → `videoEncodeArgs` (it now returns more than CRF
    flags; keeping the old name would be misleading) and add, for the
    `"libvpx-vp9"` case only:
    - `-row-mt 1` — always on, no quality/size cost (see Porquê benchmark).
    - `-tile-columns 2` — always on. Verified safe on the repo's existing
      32×32 test fixtures (`workers/testdata/media/tiny.mp4`) — libvpx clamps
      tile-columns internally for small frames rather than erroring.
    - `-threads <runtime.NumCPU()>` — sized to the host's logical CPUs via
      Go's `runtime` package (imported new in this file). The worker currently
      runs unsandboxed (no CPU-limited container in `infra/docker-compose.yml`
      — `worker` isn't a compose service yet), so `NumCPU()` reflects real
      available cores; see `docs/90-deferred-register.md` D-xx below for the
      revisit trigger once that changes.
  - Update the function's doc comment accordingly.
  - `libx264` (`mp4`) case is untouched — already threads correctly by default.
- **`workers/internal/processors/video_transcode.go`** — update the call site
  and its doc comment reference from `videoCrfArgs` to `videoEncodeArgs`.
- **`workers/internal/processors/video_compress.go`** — update the call site
  from `videoCrfArgs` to `videoEncodeArgs`.
- **`docs/90-deferred-register.md`** — add a `D-xx` entry: `-cpu-used` left at
  ffmpeg's default (1) rather than raised for more speed, because raising it is
  a real quality/size trade (measured below), not a free win, and needs an
  explicit product decision on how much drift is acceptable. Trigger: revisit
  if 3m45s-class WebM export times (this fix's measured result) are still too
  slow for a concrete use case.

### Rejected alternative

Raising `-cpu-used` (e.g. to 4) on top of the above gets a further ~37% wall
time cut (3m45s → 2m22s in testing) but produces a ~20% larger file at the same
`-crf` (4,501,013 → 5,395,015 bytes on the reference clip) — i.e. materially
worse compression efficiency for the same quality target, not a free win. Not
included in this task; left as the documented next lever (deferred register).

## Porquê

The 13-minute report is explained by this bug, not by the user's machine or
input file: `libvpx-vp9`'s row-based multithreading is opt-in in ffmpeg
(defaults to off in practice) and the worker never opted in, so every
`webm` transcode/compress runs on effectively one core no matter how many the
host has. This is a plain oversight, not a documented trade-off — grepped
`docs/90-deferred-register.md` and `TASK-video-audio-processors.md` for prior
discussion of encode speed/threading; there is none.

Measured on the exact file that triggered the report (8-core machine, ffmpeg
8.1.2, three repeated baseline runs for consistency against a noisy shared
machine):

| Config | Wall time | CPU% | Output size |
|---|---|---|---|
| Current (baseline) | 5m12s–5m52s | 233–245% | 4,588,275 B |
| `+row-mt 1 +tile-columns 2 +threads 8` (this fix) | 3m45s | 381% | 4,501,013 B (slightly smaller) |
| `+cpu-used 4` on top (rejected, see above) | 2m22s | 333% | 5,395,015 B (+20%) |

The fix is a strict improvement: ~28-36% faster wall clock, no quality or size
regression (row-mt/tile-columns are threading-only levers; the size even
dropped slightly, within CRF-mode noise). `-cpu-used` is excluded because it's
not free — CLAUDE.md's rule against silently resolving open questions applies
here: shipping smaller/lower-quality output than the user asked for via
`quality` param, silently, is exactly the kind of drift the spec's
preview/export-fidelity concern is about, even though this is compress/export
path rather than the editor preview path specifically.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `workers/internal/processors/ffmpeg.go` | edit | rename `videoCrfArgs`→`videoEncodeArgs`, add row-mt/tile-columns/threads for `libvpx-vp9`, add `runtime` import |
| `workers/internal/processors/video_transcode.go` | edit | update call site + doc comment reference |
| `workers/internal/processors/video_compress.go` | edit | update call site |
| `docs/90-deferred-register.md` | edit | add `D-xx` for `-cpu-used` left at default, with revisit trigger |
