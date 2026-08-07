#!/usr/bin/env bash
# One-command local dev environment -- see docs/tasks/TASK-dev-run-script.md.
# Invoked via `pnpm dev` (root package.json), already wrapped in
# `dotenv -e .env --` there, so every process this script starts inherits
# the repo-root .env as real environment variables.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f infra/docker-compose.yml up --wait

exec pnpm exec concurrently \
  --names "orchestrator,worker,web" \
  --prefix-colors "green.bold,yellow.bold,magenta.bold" \
  --kill-others \
  "pnpm --filter orchestrator start:dev" \
  "cd workers && go run ./cmd/worker" \
  "pnpm --filter web dev -p 3001"
