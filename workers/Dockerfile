# syntax=docker/dockerfile:1

FROM golang:1.26.5-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY go.mod go.sum ./
# internal/govips-fork is a local replace target (go.mod's `replace
# github.com/davidbyttow/govips/v2 => ./internal/govips-fork` — see
# docs/tasks/TASK-highlights-shadows-tonelut.md), so it must exist on disk
# before `go mod download` resolves it, unlike a normal registry dependency.
COPY internal/govips-fork ./internal/govips-fork
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 go build -o /out/worker ./cmd/worker

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /home/worker worker

ENV WORKER_STORAGE_DIR=/data/worker-output
RUN mkdir -p "$WORKER_STORAGE_DIR" && chown -R worker:worker /data

COPY --from=builder /out/worker /usr/local/bin/worker

USER worker
WORKDIR /home/worker

ENTRYPOINT ["worker"]
