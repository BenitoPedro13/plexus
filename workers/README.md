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
`CLAUDE.md`'s no-mocking-the-queue rule, and against small committed image fixtures in
`testdata/images/` for the processors.
