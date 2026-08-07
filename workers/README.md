# Plexus Go workers

Horizontally-scalable worker pool that consumes `plexus.jobs.dispatch` (NATS JetStream) and
runs built-in processors against the file at each step's `inputRef`. See
`docs/plexus-media-pipeline-spec.md` and `docs/tasks/TASK-nats-job-dispatch.md` /
`docs/tasks/TASK-builtin-processors.md` for the design.

## Prerequisites

- Go 1.26+ (see `go.mod`)
- **libvips 8.14+** — built-in image processors (`image.resize`, `image.convert`,
  `image.compress`) bind to it via [govips](https://github.com/davidbyttow/govips)
  (cgo). Without it, the package won't compile.

  macOS (Homebrew):

  ```sh
  brew install vips pkg-config
  export CGO_CFLAGS_ALLOW="-Xpreprocessor"
  ```

  Linux (Debian/Ubuntu):

  ```sh
  apt-get install libvips-dev pkg-config
  ```

  No CI workflow or worker `Dockerfile` exists yet (`D-12` in
  `docs/90-deferred-register.md`) — whichever task adds either must install libvips
  there too.

- **ffmpeg/ffprobe** — built-in video/audio processors (`video.transcode`,
  `video.compress`, `audio.extract`, `audio.convert`) shell out to the `ffmpeg` binary via
  `os/exec` (no cgo binding — see `docs/tasks/TASK-video-audio-processors.md`). `ffprobe`
  is not required by the worker itself, only by its own tests. Without `ffmpeg` on `PATH`,
  the worker fails fast at boot (`processors.CheckAvailable()`), not on the first job.

  macOS (Homebrew):

  ```sh
  brew install ffmpeg
  ```

  Linux (Debian/Ubuntu):

  ```sh
  apt-get install ffmpeg
  ```

  Same `D-12` gap as libvips above — no CI/Dockerfile installs it yet.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `NATS_URL` | `nats://127.0.0.1:4222` (nats.go default) | JetStream connection |
| `NATS_USER` / `NATS_PASS` | unset | Only needed for brokers that require auth (e.g. testcontainers-provisioned NATS in integration tests) |
| `WORKER_STORAGE_DIR` | `./data/worker-output` | Directory processors write output files into. Local-filesystem stand-in for object storage — see `D-11` in `docs/90-deferred-register.md`; `inputRef`/`outputRef` are plain filesystem paths until Phase 3 wires up MinIO/S3. |

## Run

```sh
go run ./cmd/worker
```

## Test

```sh
go test ./...
```

Tests run against real infrastructure (NATS via testcontainers — Docker required), per
`CLAUDE.md`'s no-mocking-the-queue rule, and against small committed fixtures in
`testdata/images/` and `testdata/media/` for the processors.
