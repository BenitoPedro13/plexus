# TASK-audio-no-stream-error

## Cenário actual

`audio.extract` (`workers/internal/processors/audio_extract.go:43`) and `audio.convert`
(`workers/internal/processors/audio_convert.go:34`) both invoke ffmpeg with an explicit
`-map 0:a:0` — required to reliably drop any video/attached-picture streams and select only
the first audio stream (see `audio_extract.go`'s existing doc comment).

When the input has **no audio stream at all** (e.g. a screen recording `.mov` with video
only — this happened with a real job pointed at
`./data/worker-output/download-2809825049.mov`), ffmpeg's stream-specifier parser rejects
the map before it ever opens the input, producing:

```
Stream map '' matches no streams.
To ignore this, add a trailing '?' to the map.
Failed to set value '0:a:0' for option 'map': Invalid argument
Error parsing options for output file <out>.
Error opening output files: Invalid argument
```

`runFFmpeg` (`workers/internal/processors/ffmpeg.go:21`) wraps this stderr verbatim, so the
job's returned error reads: `extract audio from "<in>" as mp3: ffmpeg -i <in> -vn -map
0:a:0 ...: exit status 234: Stream map '' matches no streams. ...` — accurate but opaque;
"Stream map ''" and "add a trailing '?'" refer to ffmpeg's own CLI syntax, not to anything
the caller (job-failure UI, logs) can act on without knowing ffmpeg internals.

This is not an untested code path by accident — `docs/tasks/TASK-video-audio-processors.md`
("Porquê", lines 195-201) *deliberately* chose not to add an `ffprobe` pre-check, reasoning
that "ffmpeg itself produces a clear stderr message... if `audio.extract` is pointed at a
file with no audio stream." That assumption doesn't hold: the message above is not clear to
anything downstream of `runFFmpeg`. Confirmed by reproducing locally: a 32×32/0.5s
video-only fixture (`ffmpeg -f lavfi -i testsrc=size=32x32:rate=25:duration=0.5 -c:v libx264
-pix_fmt yuv420p`) run through the exact `audio.extract` ffmpeg invocation reproduces the
quoted stderr exactly, including `exit status 234`.

Separately, `audio_extract_test.go`'s existing test named "input with no audio stream is an
error" (line 83) doesn't actually test this — it passes a nonexistent file path, which fails
for an unrelated reason (`-i` can't open the file at all). There is no real coverage of the
no-audio-stream case today.

## Mudanças planeadas

- **`workers/internal/processors/ffmpeg.go`** — add a small helper,
  `isNoAudioStreamError(err error) bool`, that checks whether an error returned by
  `runFFmpeg` matches ffmpeg's `Stream map '' matches no streams` stderr (the specific
  failure `-map 0:a:0` produces when the input has zero audio streams). Substring match on
  the wrapped error text — deliberately not parsing ffmpeg's exit code (234 is a generic
  "bad option" code, not specific to this case) or stderr structure further than needed.

- **`workers/internal/processors/audio_extract.go`** — after `runFFmpeg` fails, check
  `isNoAudioStreamError`; if true, return a clear domain error (`input %q has no audio
  stream to extract`) wrapping the original ffmpeg error with `%w` (so the raw stderr is
  still available to anyone inspecting the error chain/logs), instead of the current generic
  `extract audio from %q as %s: %w` wrap.

- **`workers/internal/processors/audio_convert.go`** — same translation, worded for convert
  (`input %q has no audio stream to convert`). Same `-map 0:a:0` flag, same failure mode.

- **`workers/internal/processors/audio_extract_test.go`** — fix the mislabeled "input with
  no audio stream is an error" test to actually exercise this: use a new committed
  video-only fixture and assert the returned error both (a) occurs and (b) contains "no
  audio stream" (not just "an error", so the test would fail if the translation regressed
  back to the raw ffmpeg message). Keep a separate case for the nonexistent-file scenario
  the old test accidentally covered, since that's a distinct, real failure mode worth its
  own assertion.

- **`workers/internal/processors/audio_convert_test.go`** — add the equivalent case for
  `audio.convert`.

- **`workers/testdata/media/tiny-noaudio.mp4`** (new) — committed fixture, video-only, same
  generation recipe as the existing `tiny.mp4`/`tiny.webm` (`ffmpeg -f lavfi -i
  testsrc=size=32x32:rate=25:duration=0.5 -c:v libx264 -pix_fmt yuv420p`) minus the `sine`
  audio input and `-c:a`/`-map` args.

Rejected alternative: adding an `ffprobe` pre-check (reopening
`TASK-video-audio-processors.md`'s explicit decision). Not needed — the fix here keeps
relying on ffmpeg's own detection of the problem, it just translates the message ffmpeg
already gives us into something a caller can read, which is a much smaller change and adds
no new dependency/process-spawn to the hot path.

## Porquê

A worker job just hit exactly this: a `.mov` with no audio track pointed at `audio.extract`
failed with a stderr dump referencing ffmpeg's internal stream-specifier syntax
(`Stream map ''`, "add a trailing '?'") instead of a message that says what actually
happened ("this file has no audio to extract"). That's a real UX/debuggability gap for
whoever reads job-failure reasons (currently: logs; eventually: the orchestrator surfacing
step failures to the frontend), not a hypothetical one.

The previous task doc's reasoning for skipping `ffprobe` — trust ffmpeg's own error
reporting rather than hand-rolling a pre-check (CLAUDE.md §2) — is still sound in principle;
what was wrong was the assumption that ffmpeg's raw message *is* already clear. Translating
the specific, reproducible string ffmpeg emits for this one case is the smallest fix that
corrects that assumption without reversing the underlying design decision or adding a new
subprocess call per job.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `workers/internal/processors/ffmpeg.go` | edit | add `isNoAudioStreamError` helper |
| `workers/internal/processors/audio_extract.go` | edit | translate no-audio-stream ffmpeg error into a clear message |
| `workers/internal/processors/audio_convert.go` | edit | same translation for convert |
| `workers/internal/processors/audio_extract_test.go` | edit | fix mislabeled test to use a real no-audio fixture; keep nonexistent-file case separately |
| `workers/internal/processors/audio_convert_test.go` | edit | add equivalent no-audio-stream case |
| `workers/testdata/media/tiny-noaudio.mp4` | new | committed video-only fixture (no audio stream) |
