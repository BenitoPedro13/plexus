# TASK-editor-export

## Cenário actual

Phase 2 (Editor MVP)'s P0 requirements (spec `Requirements` §P0) are now all done except
one:

- Non-destructive recipe model (crop, light, color, filter) — done.
- Live client-side preview via WebGPU/WebGL2 — done.
- Curated composite controls — done.
- **"Export produces the same recipe format Plexus pipelines consume — no separate
  'convert my edit into a pipeline' step."** — **not implemented.** There is no way today
  to turn an in-progress edit into a downloadable file at full resolution. The editor
  (`apps/web/src/app/editor/page.tsx`) only ever renders into the live-preview canvas.

Concretely, nothing in the codebase can execute a `Recipe` end-to-end and hand back bytes:

- `workers/internal/processors/registry.go`'s `Lookup(name string) (Func, bool)` is the
  only exported entry point into processor logic, where
  `type Func func(ctx, jobStepID, inputRef string, params map[string]interface{}) (outputRef string, err error)`
  reads/writes **local filesystem paths** (`inputRef`/`outputRef`, under
  `WORKER_STORAGE_DIR`, `D-11`). Nothing chains two `Func` calls together — multi-step
  chaining today lives entirely on the **TS side**, in the orchestrator's
  `job-dispatch.service.ts`/`job-result-handler.ts`, which drive one step at a time over
  NATS and are inherently async/DB-backed (`jobs`/`pipeline_steps` tables).
- `workers/` has **no HTTP server anywhere** — `workers/cmd/` contains only the `worker`
  NATS-consumer daemon and two CLI fixture-generator tools
  (`gendriftgolden`/`gendriftfixture`). The only way to invoke a processor today is
  NATS message → `dispatch.Handle` → `processors.Lookup`.
- `apps/orchestrator`'s `POST /pipelines` only stores a pipeline definition; `POST /jobs`
  dispatches it **asynchronously** over NATS and the caller polls `GET /jobs/:id`, which
  returns DB status rows, not file bytes. There is no download/result-fetch route, and
  `pipelines/dto/create-pipeline.dto.ts`'s `BUILTIN_PROCESSORS` is still the narrower
  Phase-1 list (7 ids) — it doesn't even know about `image.crop`/`adjustLight`/
  `adjustColor`/`blackAndWhite`/`sharpen` yet (`D-17`).
- There is **no file-ingestion path** into the Go side at all. Every existing Go test
  seeds `WORKER_STORAGE_DIR` directly on disk (`t.Setenv` + writing fixture bytes) —
  there's no precedent anywhere for getting a browser-uploaded file to where a processor
  can `vips.NewImageFromFile` it.
- `apps/web` has **zero `fetch(` calls** anywhere in `src/` and no `app/api/` routes — the
  whole app is client-only today (decode → WebGPU/WebGL2 preview, nothing leaves the
  browser). `editor/page.tsx`'s `handleFileChange` (line 122) converts the uploaded
  `File` straight to an `ImageBitmap` via `createImageBitmap` and **discards the original
  `File`** — nothing currently retains the original bytes needed to re-send for a
  full-resolution render.

## Mudanças planeadas

The spec's own phasing note is the scope fence here: *"Phase 2 — ... export. No batch
integration yet"* vs. *"Phase 3 — ... wiring the editor's recipe into the pipeline engine
so 'apply to batch' actually works."* So this task builds a **synchronous, single-image,
no-persistence render path** that proves recipe → real Go pixels → downloadable file,
without touching the orchestrator's async job/pipeline machinery (DB job rows, NATS
dispatch, `BUILTIN_PROCESSORS`) at all — that machinery is Phase 3's job, for batch. This
keeps today's task additive and small, and gives Phase 3 a `RunRecipe`-shaped building
block to reuse instead of starting from zero.

It also keeps the Go/TypeScript split intact (CLAUDE.md §0/§4): apps/web never talks to
Go directly. It POSTs to the orchestrator (the project's designated API surface — also
where auth will eventually gate this, `D-4`), which proxies synchronously to a new Go
render server.

1. **`workers/internal/render/render.go`** (new) — `RunRecipe(ctx, renderID, sourcePath
   string, steps []RecipeStep) (outputPath string, cleanup func(), err error)`. Walks
   `steps` in order, calling `processors.Lookup(step.Processor)` for each and feeding the
   previous step's `outputRef` in as the next step's `inputRef` (first step uses
   `sourcePath`). Each step gets a synthetic `jobStepID` of `render-<renderID>-<index>` —
   `Func`'s signature requires one for its output filename, no change to `Func`, `Lookup`,
   or any existing processor. **Revised during implementation** from this doc's original
   per-render-temp-directory plan: `processors.Func` resolves `WORKER_STORAGE_DIR` itself
   via `os.Getenv` (a process-global read, `processors/output.go`), so mutating that env
   var per HTTP request would race under concurrent renders. Instead `RunRecipe` writes
   into the same shared `WORKER_STORAGE_DIR` the async job path already uses concurrently
   today (safe there via each job step's own unique id — the same mechanism this reuses),
   and `cleanup()` removes exactly the files this call created (tracked as it walks the
   chain), not a whole directory. An empty `steps` list is valid (matches `Recipe.steps`
   being optional/empty in the Zod schema) and just returns `sourcePath` unchanged, with a
   no-op cleanup that never touches the caller's own source file.
2. **`workers/internal/render/message.go`** (new) — `RecipeStep{ Processor string, Params
   map[string]interface{} }`, the JSON shape the HTTP handler decodes the recipe into.
   Deliberately not shared with `apps/web/src/lib/recipe/schema.ts`'s Zod type or the
   orchestrator's `StepDto` — same accepted hand-duplication as `D-8`/`D-17`, not new debt
   shape. Validation is intentionally **not re-implemented here**: each processor `Func`
   already validates its own params (used identically by the trusted NATS dispatch path
   today), so a bad/missing param surfaces as that `Func`'s existing error, not a second
   schema.
3. **`workers/cmd/renderserver/main.go`** (new binary) — a small `net/http` server (no
   framework; CLAUDE.md prefers boring proven tooling, and one route doesn't justify one).
   `POST /render`: multipart form with a `file` part (the source image) and a `recipe`
   part (JSON array of `RecipeStep`). Steps: `vips.Startup()` (existing processors package
   init), write the uploaded file to a temp path (`http.MaxBytesReader` capping request
   size — no size cap exists anywhere in the stack today and this is the first place raw
   client bytes hit the Go binary), call `render.RunRecipe`, stream the result back with
   the correct `Content-Type` (derived from the output file's extension, same mapping
   `convert.go`/`compress.go` already use), then `cleanup()`. Listens on
   `RENDER_SERVER_ADDR` (default `:8090`).
4. **`workers/internal/render/render_test.go`** + **`workers/cmd/renderserver/main_test.go`**
   (new) — golden-fixture style, no mocking (CLAUDE.md Tests): `render_test.go` chains 2–3
   real processors (e.g. `image.crop` → `image.resize` → `image.adjustLight`) against a
   committed fixture and asserts output dimensions/format, proving order/chaining is
   correct end-to-end through real govips calls. `main_test.go` drives the HTTP handler
   with `httptest`, a real multipart body, and asserts a real image comes back.
5. **`apps/orchestrator/src/export/`** (new module — `export.module.ts`,
   `export.controller.ts`) — `POST /export`, `FileInterceptor('file')`
   (`@nestjs/platform-express`, already a dependency) reads the uploaded file + a `recipe`
   form field, forwards both as a multipart request to `RENDER_SERVER_URL` (env var,
   `.env.example` gains it — default `http://localhost:8090`), and pipes the Go response
   back to the caller with its `Content-Type` preserved. A body-size limit is set
   consistent with the Go side's `http.MaxBytesReader` cap (same number, documented once).
   No DB/NATS involvement — this bypasses `PipelinesModule`/`JobsModule` entirely, by
   design (see Porquê). Wired into `app.module.ts`'s `imports`.
6. **`apps/orchestrator/src/export/export.controller.spec.ts`** (new) — proxies against a
   stubbed `RENDER_SERVER_URL` (a real local `http.Server` started in the test, not a
   mock of NestJS internals — consistent with "don't mock what you can run for real," even
   though the no-mocking rule's letter is scoped to DB/queue).
7. **`apps/web/src/app/editor/page.tsx`** — `handleFileChange` additionally keeps the
   original `File` in a new `sourceFile` state (alongside the existing decoded `image:
   ImageBitmap`), since the export path needs the untouched original bytes, not a
   canvas-re-encoded copy. New "Export" button, disabled until `sourceFile` is set; on
   click, builds a `FormData` (`file` + `recipe: JSON.stringify(recipe)`), `fetch`s
   `POST {NEXT_PUBLIC_ORCHESTRATOR_URL}/export`, and on success triggers a browser
   download (`URL.createObjectURL` + a temporary `<a download>`, then revoke the URL).
8. **`apps/web/src/lib/editor/export.ts`** (new) — the `FormData`-building + download-
   triggering logic extracted as a small pure-ish function (same extraction rationale
   already used for `light-blend.ts`/`crop-drag.ts`: keeps `page.tsx` thin and the logic
   unit-testable without a DOM file-input). Gets its own `export.test.ts`.
9. **`.env.example`** (root) — add `RENDER_SERVER_ADDR=:8090` and
   `RENDER_SERVER_URL=http://localhost:8090` (Go listen address vs. orchestrator's client
   URL — same pattern as `NATS_URL` already being consumed from both sides).
   `apps/web/.env.local` convention — check whether one exists; if not, document
   `NEXT_PUBLIC_ORCHESTRATOR_URL` inline in this task's affected-files table rather than
   inventing a new env file convention unprompted.

**Explicitly not in scope** (goes in the deferred register in the same pass, §3):
containerizing/CI-wiring `renderserver` (mirrors `D-16`'s worker-image gap), auth-gating
`POST /export` (`D-4` still open), routing export through real object storage instead of
per-request temp files (`D-3` still open — this task's temp-file approach is fine
precisely because nothing is persisted or shared across requests), and any resumable/
progress UI for export (it's a single synchronous request — no SSE needed here, unlike
Phase 3's batch jobs).

## Porquê

This is the last unimplemented P0 bullet for Phase 2, and CLAUDE.md's phasing note
explicitly frames Phase 2 as "a shippable milestone on its own" — without export, the
editor can't actually produce anything a user could keep, which undercuts that claim. The
alternative designs considered and rejected:

- **Route export through the orchestrator's existing async job/pipeline machinery**
  (`POST /pipelines` + `POST /jobs`, poll `GET /jobs/:id`). Rejected: that machinery is
  DB-backed, NATS-dispatched, and designed for durability across many files — exactly
  right for Phase 3's "Apply to Batch," architecturally overkill for "render the one image
  I'm looking at right now and give it back to me." Building it now would just *be* Phase
  3's work, early, for N=1, contradicting the spec's own phase boundary ("no batch
  integration yet").
- **apps/web talks to a new Go HTTP endpoint directly, skipping the orchestrator.**
  Rejected: breaks the stack's designated API surface (orchestrator = auth + business
  logic front door per the stack table) and forecloses gating this behind auth later
  (`D-4`) at the one place auth will actually live.
- **Add HTTP handling to the existing `worker` NATS-consumer binary** instead of a new
  `renderserver` binary. Rejected: keeps the async dispatch loop's failure modes (a
  blocked/slow synchronous HTTP request head-of-line-blocking NATS message processing in
  the same process) separate from a new, different failure mode (a slow render blocking an
  HTTP client) — two small single-purpose binaries over one binary doing two unrelated
  things, and it costs nothing extra (`processors.Lookup`/`RunRecipe` are shared regardless
  of which binary calls them).

`RunRecipe`'s existence is itself forward-looking, not scope creep: Phase 3's real "Apply
to Batch" will eventually need something that walks a `Recipe`'s steps in order and knows
how to feed one step's output into the next — today that logic lives only in the TS
orchestrator's per-step NATS dance. Having `RunRecipe` already exist and already proven
(via this task's own tests, chaining real processors) means Phase 3 has a candidate to
reuse or explicitly diverge from, instead of designing chaining logic from a blank page.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `workers/internal/render/render.go` | new | `RunRecipe` — chains `processors.Lookup` calls in recipe order |
| `workers/internal/render/message.go` | new | `RecipeStep` JSON decode shape |
| `workers/internal/render/render_test.go` | new | golden-fixture chain test, no mocking |
| `workers/cmd/renderserver/main.go` | new | sync HTTP server, `POST /render` |
| `workers/cmd/renderserver/main_test.go` | new | `httptest`-driven handler test |
| `apps/orchestrator/src/export/export.module.ts` | new | wires controller into Nest DI |
| `apps/orchestrator/src/export/export.controller.ts` | new | `POST /export`, proxies to `RENDER_SERVER_URL` |
| `apps/orchestrator/src/export/export.controller.spec.ts` | new | proxies against a real local stub server |
| `apps/orchestrator/src/app.module.ts` | edit | add `ExportModule` to `imports` |
| `apps/web/src/app/editor/page.tsx` | edit | retain `sourceFile`, add Export button |
| `apps/web/src/lib/editor/export.ts` | new | `FormData` build + download trigger, extracted for testing |
| `apps/web/src/lib/editor/export.test.ts` | new | unit tests for the extracted logic |
| `.env.example` | edit | add `RENDER_SERVER_ADDR`, `RENDER_SERVER_URL` |
| `apps/web/.env.example` | new | `NEXT_PUBLIC_ORCHESTRATOR_URL` — Next.js loads env files from its own app dir, not the monorepo root's |
| `docs/plexus-media-pipeline-spec.md` | edit | close the P0 export bullet's implicit gap, note sync-vs-batch split |
| `docs/90-deferred-register.md` | edit | new `D-xx`: renderserver not containerized/CI-wired; export bypasses auth (`D-4`) and object storage (`D-3`) by design |

Waiting for alignment before writing any code — flag now if the sync-render-server shape
(vs. reusing the async pipeline, or skipping the orchestrator) isn't the right call.
