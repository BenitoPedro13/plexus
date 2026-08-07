# TASK: httpyac userflow test suite for the orchestrator's HTTP API

## Cenário actual

The orchestrator's full HTTP surface (10 endpoints across 5 controllers — `app`,
`pipelines`, `jobs`, `export`, `uploads`) is already covered by 56 Jest tests running
against real Postgres/NATS/MinIO via testcontainers (`*.integration-spec.ts` /
`*.spec.ts` under `apps/orchestrator/src`). That suite is, and remains, the correctness
authority per `CLAUDE.md`'s no-mocking rule — this task does not touch it.

What's missing is a **declarative, git-committed, human-readable layer** that exercises
the same endpoints as actual chained HTTP requests against a running dev stack — the kind
of thing the user originally reached for Postman/a browser extension to do (prior
conversation). Earlier research in this same task-doc process (see conversation, not
re-litigated here) compared httpyac, Bruno, Postman/Newman, and Hurl (`hurl.dev` was
unreachable to verify, dropped from consideration) specifically against the requirement
that most real userflows here end in watching `GET /jobs/:id/events` (SSE) — only httpyac
has confirmed, documented native SSE support (`SSE` method, `{{@streaming}}` hook).
Decision: httpyac.

No `.http` files, no `httpyac` dependency, and no `test:http` script exist anywhere in the
repo today. `apps/orchestrator/test/` currently holds only the Nest-scaffolded
`app.e2e-spec.ts` + `jest-e2e.json` + `support/`.

## Mudanças planeadas

**New directory: `apps/orchestrator/test/http/`** — parallel to the existing
`test/` e2e location, but for the declarative httpyac layer instead of Jest. One `.http`
file per userflow (crossing controllers, not one-per-controller, since real flows do):

- No `.env` file: this repo's root `.gitignore` blanket-ignores `.env`/`.env.local`/
  `.env.*.local` (line 19-21), so a `test/http/.env` would never actually be committed —
  discovered live when `git status` showed it silently untracked after staging. Each file
  instead declares `@ORCHESTRATOR_URL = http://localhost:3000` as a plain file-scoped
  variable on its own line (confirmed working), keeping every file self-contained with no
  hidden setup step.
- **`pipeline-lifecycle.http`** — `POST /pipelines` (linear 2-step pipeline) → `?? status
  == 201` → `# @name pipeline` → `GET /pipelines/{{pipeline.id}}` → assert steps match
  what was submitted.
- **`upload-presign-flow.http`** — `POST /uploads/presign` (`{filename, contentType}`) →
  assert a presigned PUT URL comes back → `GET /uploads/presign-download?key=...` using the
  key from the first response → assert a presigned GET URL comes back.
- **`job-single-flow.http`** — create a linear pipeline → `POST /jobs` with a placeholder
  `inputRef` → `SSE GET /jobs/{{job.id}}/events` with a short `{{@streaming}}` sleep hook
  (~8s, just to surface streamed frames in CLI output — see "design note" below) → then a
  plain `GET /jobs/{{job.id}}` with `?? js response.parsedBody.status == "COMPLETE"` as the
  actual pass/fail assertion.
- **`job-batch-flow.http`** — presign 2 uploads → `POST /jobs/batch` with both `inputRefs`
  → assert 2 jobs come back, each `GET /jobs/:id` reaches a terminal status.
- **`dag-fan-out.http`** — the branching pipeline from the prior smoke-test task doc
  (`root: image.resize` → `a: image.compress`, `b: image.convert`, both `dependsOn:
  ["root"]`) → job → SSE tail → `GET /jobs/:id` asserting `status == "PARTIAL"` (or
  `COMPLETE` once the underlying processor actually runs against a real fixture — see
  design note) and that both `a` and `b` step rows are present in the response.
- **`dag-fan-in-rejected.http`** — negative case: `POST /pipelines` with a step whose
  `dependsOn` has length 2 → `?? status == 400` and `?? js
  response.parsedBody.reason == "FAN_IN_NOT_SUPPORTED"`.
- **`export-flow.http`** — multipart `POST /export` with a small committed fixture image
  + a one-step recipe in the `recipe` field → `?? status == 200`. Header comment states the
  precondition explicitly: this endpoint proxies to `workers/cmd/renderserver`, which
  `pnpm dev` does **not** start (only orchestrator + worker + web, per `scripts/dev.sh`) —
  running this file requires `cd workers && go run ./cmd/renderserver` separately first,
  otherwise it correctly fails with 502.

**Edit: `apps/orchestrator/package.json`** — add `httpyac` as a devDependency and a
`"test:http": "httpyac send test/http/*.http --all --bail"` script (`--bail` stops on first
failing assertion; `--junit`/`--json` reporter flags are documented as available for actual
CI wiring later but not made the default here — this task adds the tool and files, not a
CI job).

**Edit: `README.md`** (`## Testing`, `README.md:156-171`) — add a short paragraph + `pnpm
--filter orchestrator test:http` pointer distinguishing this layer (manual/local, requires
a running `pnpm dev` stack) from the testcontainer suite (self-contained, CI-gating).

**Edit: `apps/orchestrator/README.md`** — same pointer in its own test-instructions
section.

**Design note — why the SSE step doesn't itself assert, and is disabled by default:**
httpyac's documented `{{@streaming}}` pattern (their own example) waits a fixed duration
(`await sleep(10000)`) before closing the connection; their docs don't show an API for
inspecting individual received SSE frames and terminating early on a matched value. Each
flow's SSE step is "watch and print" only — the actual pass/fail assertion happens on a
follow-up plain `GET` of the job's final state. Confirmed live against a running stack that
this SSE step is actively unreliable in an automated run, not just unhelpful: for these
tiny fixtures the job is often already terminal by the time the SSE connection opens, the
server closes the stream, and the underlying EventSource client auto-reconnects and gets a
400 — which httpyac counts as a failed request and trips `--bail`. Every SSE request is
therefore marked `# @disabled` (httpyac skips it under `--all`, confirmed live), left in
the file purely for a human to delete that line and watch it manually. The deterministic
wait before the follow-up `GET` uses httpyac's `# @sleep <ms>` metadata instead (also
confirmed live) — simpler and non-flaky compared to depending on the SSE connection's
lifecycle for timing.

**Other things only caught by testing against the real stack, not doc-reading:**
- `?? js <expr> == <literal>` is not real JS `eval` — httpyac splits the line on the
  *first* `==` and treats everything after it as a raw, unquoted string compared loosely
  against the LHS. Quoting the RHS (`== "COMPLETE"`) compares against the literal
  characters `"COMPLETE"` and always fails; `===` breaks the same way (splits into `==` +
  leftover `= COMPLETE`). Every assertion in this task's files uses a single unquoted `==`
  with no embedded second `==`/`===` inside the expression (e.g. step-id checks use
  `.map(...).sort().join(",") == a,b,root` rather than `.some(s => s.stepId == "a")`).
- A `?? js <expr>` line with no comparison operator at all (a bare truthy check) doesn't
  get parsed as a standalone assertion — it bleeds into whatever comes next (observed as
  extra characters appended to the *following* request's JSON body, breaking that request's
  parse on the server). Existence checks use `!= null` instead of a bare property access.
- Asserting `status == QUEUED` immediately after `POST /jobs` is flaky:
  `JobsService.create()` calls `dispatchNext()` before returning, so the response can
  already reflect `RUNNING` (or, for a fixture this small, even `COMPLETE`) by the time it
  arrives. Dropped that assertion; the terminal-state `GET` afterward is the real check.
- Stacking multiple `# @ref` lines on one request (needed to pull in both an uploaded
  file's `objectKey` and a pipeline's `id`) isn't shown in httpyac's own examples but is
  confirmed working live, up to three stacked refs (`job-batch-flow.http`).

Alternatives considered: co-locating these under `docs/` or a root `test-http/` — rejected,
`apps/orchestrator/test/` already exists as this app's test-artifact location and mirrors
Nest's own `test/` convention rather than inventing a new one.

## Porquê

The user wants readable, git-committed test files covering every orchestrator endpoint and
full userflows per feature, distinct from the Jest suite. httpyac is the only tool in the
comparison with documented native SSE support, and SSE (`GET /jobs/:id/events`) is the
step nearly every real userflow ends on — picking a tool without it would mean splitting
each flow across two tools. This complements rather than replaces the testcontainer suite:
that suite stays the CI-gating correctness authority (real infra, no mocking, already
passing); this layer is a manual/local, human-readable companion useful for demoing a
userflow, onboarding, or debugging by hand — exactly what the user originally reached for
Postman to do.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/orchestrator/test/http/pipeline-lifecycle.http` | new | create + get pipeline |
| `apps/orchestrator/test/http/upload-presign-flow.http` | new | presign upload + download |
| `apps/orchestrator/test/http/job-single-flow.http` | new | pipeline → job → SSE watch → terminal-state assert |
| `apps/orchestrator/test/http/job-batch-flow.http` | new | presign×2 → batch job → both terminal |
| `apps/orchestrator/test/http/dag-fan-out.http` | new | branching pipeline → job → PARTIAL/COMPLETE assert |
| `apps/orchestrator/test/http/dag-fan-in-rejected.http` | new | negative case, 400 + `FAN_IN_NOT_SUPPORTED` |
| `apps/orchestrator/test/http/export-flow.http` | new | multipart export, documents renderserver precondition |
| `apps/orchestrator/package.json` | edit | add `httpyac` devDependency + `test:http` script |
| `README.md` | edit | `## Testing` section, pointer to new layer |
| `apps/orchestrator/README.md` | edit | same pointer in app-local test instructions |

## Verification

`pnpm --filter orchestrator test:http` run live against a real local stack (`docker
compose -f infra/docker-compose.yml up`, the user's already-running `pnpm dev`, plus
`workers/cmd/renderserver` started separately for `export-flow.http`): all 7 files, 28
requests processed, 25 succeeded, 3 skipped (the `@disabled` SSE watch-and-print steps) —
0 failures. `httpyac` was added via `pnpm add -D httpyac` (not hand-pinned), resolved to
`^6.16.7`.
