# Plexus — Extensible Media Processing Pipeline

*Working name. A "plexus" is a network of interconnected nodes — fits a DAG of pluggable processors.*

## Problem Statement

Existing personal-project media tools (including your own video-to-MP3 converter) tend to be single-purpose pipelines: upload → one fixed transformation → download. There's no project in your portfolio that demonstrates a **general-purpose, extensible processing engine** — something closer to what a real media infrastructure team would build (think: a mini Cloudinary / Zapier-for-media). This is a gap worth closing technically: it forces you to solve job orchestration, plugin extensibility, high-throughput worker design, and real-time streaming in one coherent system, and it gives you a Go codebase with real performance stakes instead of a toy CLI.

There's a second, equally important gap: the *user-facing* surface. Engineering-first tools tend to expose their internals (queues, jobs, DAGs) directly in the UI, which makes them feel powerful but unapproachable. The bar here is Apple Photos — direct manipulation, instant feedback, curated controls — where the underlying complexity (in Apple's case, Core Image; in Plexus's case, the pipeline engine) is completely invisible to the person dragging a slider. The editor is where these two goals either reinforce each other or collide, so it's treated as a first-class part of this spec, not a UI afterthought bolted onto the backend.

## Goals

1. Support arbitrary **multi-step pipelines** (DAGs), not just single conversions — e.g. `resize → watermark → compress → convert`.
2. Make processing steps **pluggable** without redeploying the core system.
3. Handle **high file-volume / high-throughput** workloads with horizontally scalable Go workers.
4. Give users **real-time progress** on long-running jobs, including partial/streamed results where possible.
5. Demonstrate a clean **Go (performance) / TypeScript (orchestration & DX)** split that's architecturally justified, not just "because I felt like it."
6. Deliver an **image editor that feels like Apple Photos** — direct manipulation, instant live preview, curated controls — with none of the pipeline/DAG complexity visible to the person using it.
7. Unify the editor and the pipeline engine around one concept: an edit made by hand on one image should be reusable as a batch operation on many, without the user doing any extra work to "convert" it.

## Non-Goals (v1)

- Full non-linear video editing (timeline-based editing) — out of scope; this is a *processing* tool, not a video editor.
- Multi-tenant billing/SaaS features (usage quotas, Stripe metering) — interesting later, not core to proving the architecture.
- Mobile apps — web only.
- User-authored UI for building pipelines visually (drag-and-drop DAG builder) — v1 pipelines are defined via JSON/YAML or preset templates; a visual builder is a strong v2 candidate.
- Professional RAW development (color science on camera RAW files, lens correction profiles) — v1 targets standard image formats (JPEG/PNG/WebP/HEIC); RAW support is a plausible v2, not a v1 bet.
- The editor exposing pipeline/DAG concepts (job status, processor names, queues) anywhere in its UI — if a user needs to know what a "processor" is to use the editor, this goal has failed.

## Core Concepts

**Pipeline** — a DAG of steps defined declaratively (JSON/YAML), e.g.:
```yaml
name: web-optimize-image
steps:
  - id: resize
    processor: image.resize
    params: { width: 1600 }
  - id: compress
    processor: image.compress
    depends_on: [resize]
    params: { quality: 80 }
  - id: convert
    processor: image.convert
    depends_on: [compress]
    params: { format: webp }
```

**Processor** — a single unit of work (resize, transcode, compress, convert, watermark, OCR, etc.). Two tiers:
- **Built-in processors**: compiled into Go workers for max performance (resize, transcode via ffmpeg, compress).
- **External plugins**: any process implementing a small gRPC contract (`Process(input) -> output`), registered at runtime. This is what makes the system "plugin-based" — a third party (or future-you) can add a new file type/transform in *any language* without touching the core.

**Job** — an instance of a pipeline run against a specific input file, tracked through a state machine (`queued → running → partial → complete/failed`), with per-step status.

**Edit Recipe** — the concept that unifies the editor with the pipeline engine. Every adjustment a user makes in the editor (crop, light, color, filter, format) is stored as a parameter, never a pixel mutation — the same non-destructive model Apple Photos uses. A recipe is just a small, ordered list of `{ processor, params }` entries — which is *structurally identical* to a Plexus pipeline. "Edit one image" and "define a pipeline" become the same underlying data structure, viewed through two different UIs (direct-manipulation editor vs. YAML/preset). This is what makes "edit once, apply to 500 files" nearly free architecturally instead of a separate feature. Concrete type: `apps/web/src/lib/recipe/schema.ts` (`docs/tasks/TASK-recipe-schema.md`) — a Zod schema covering the Phase 1 image processors (`image.resize`, `image.convert`, `image.compress`); kept inside `apps/web` rather than a shared `packages/` module until Phase 3 needs the orchestrator to consume it too (see `docs/90-deferred-register.md` D-1).

## Image Editor (Frontend UX Layer)

This is the user-facing surface most people will actually judge the product by, so it gets its own section instead of being folded into "frontend" as an afterthought.

**Design principles, in priority order:**

1. **Non-destructive, recipe-based editing.** Nothing is "applied" to pixels until export. Every control writes to the current recipe; the displayed image is always original-plus-recipe, computed fresh. This gives free undo/redo (just recipe history) and is the same mechanism that powers batch reuse.
2. **Live, client-side preview — no server round-trips per adjustment.** Dragging a slider must feel instant. Preview rendering happens in the browser via **WebGPU** compute/render pipelines operating on the recipe parameters; the Go backend is only invoked for the final full-resolution export and for batch runs. This is the single biggest lever for making a web editor feel native instead of laggy. (Given WebGPU's browser support isn't universal yet, plan a graceful fallback path — e.g. a reduced-fidelity Canvas2D/WebGL preview, or a brief "your browser doesn't support the fast editor yet" state — rather than blocking the whole editor on it.)
3. **Curated composite controls over raw parameters.** The primary surface is a small set of smart sliders (Light, Color, B&W, Sharpen — Apple's vocabulary, not Lightroom's) that each move several underlying recipe parameters together. Raw/individual parameters live one level deeper behind "Adjust manually," for people who want them.
4. **Presets as the primary entry point, manual editing as the escape hatch.** The default flow is "pick a look" (a named, pre-built recipe), not "open blank editor." A preset is nothing more than a starter recipe — reusing the same data structure again. Manual editing starts from either a blank recipe or a preset the user is customizing.
5. **Intent-based editing as a stretch capability, not the default.** Beyond presets, a single input like "make this pop" or "fix the lighting" can map to a generated recipe (parameter set) rather than requiring the user to touch any sliders at all. Treated as P2 — genuinely valuable but higher-risk (needs a model/heuristic behind it) and not required for the editor to already feel excellent.
6. **Editing can happen in context, not only on a dedicated page.** Where it's cheap to do so (e.g. hovering a thumbnail in a gallery/batch view), lightweight adjustments are available inline rather than forcing navigation to a separate editor route. The full editor page remains the primary surface for anything beyond quick touch-ups.

## Architecture Overview

```
┌─────────────────────┐
│  Editor (WebGL/      │  Client-side only. Renders original image +
│  WebGPU shaders,     │  recipe live, no server round-trip per edit.
│  runs in-browser)    │  On export/"apply to batch": sends the recipe
└──────────┬───────────┘  (not pixels) to the Orchestrator.
           │ recipe JSON
           ▼
┌─────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Next.js    │◄────►│  Orchestrator     │◄────►│  Postgres            │
│  Frontend   │ SSE/ │  (NestJS/TS)      │      │  (jobs, pipelines,   │
│  (upload,   │  WS  │  - Auth           │      │   recipes, plugin    │
│  dashboard, │      │  - Pipeline DAG   │      │   registry)          │
│  live       │      │    resolver       │      └─────────────────────┘
│  progress)  │      │  - Job state      │
└─────────────┘      │    machine        │      ┌─────────────────────┐
                      └────────┬──────────┘◄────►│  MinIO / S3          │
                               │                  │  (input/output files,│
                       publish/│consume           │   presigned URLs)     │
                               ▼                  └─────────────────────┘
                      ┌──────────────────┐
                      │  NATS JetStream   │  (job queue + event bus,
                      │  (streams/subjects)│  persistent, replayable)
                      └────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
      ┌───────────────┐ ┌───────────────┐ ┌───────────────────┐
      │ Go Worker Pool │ │ Go Worker Pool │ │ External Plugin    │
      │ (built-in:     │ │ (autoscaled,   │ │ (gRPC, any lang —  │
      │  ffmpeg, libvips│ │  horizontally  │ │  e.g. Python for   │
      │  ,compress)     │ │  scalable)     │ │  ML-based upscale) │
      └───────────────┘ └───────────────┘ └───────────────────┘
```

**Why NATS JetStream over RabbitMQ** (which you already used): it gives you a persistent, replayable event log in addition to queueing, which maps naturally onto both job dispatch *and* the real-time progress event stream — one piece of infra instead of two. It's also a good excuse to learn a second messaging paradigm instead of reaching for the same tool again.

## Go vs TypeScript Split

| Layer | Language | Why |
|---|---|---|
| Frontend | TypeScript (Next.js) | DX, your strongest stack |
| Orchestrator (API, auth, DAG resolution, job state) | TypeScript (NestJS) | I/O-bound, benefits from your existing NestJS fluency, fast iteration on business logic |
| Worker pool (built-in processors) | **Go** | CPU-bound (ffmpeg/libvips calls, compression), needs real concurrency and low memory overhead per worker — this is where Go actually earns its place, not just "for variety" |
| Plugin contract | gRPC (protobuf) | Language-agnostic by design — a plugin author could write theirs in Python, Rust, whatever |
| Realtime gateway | TypeScript (or Go if load justifies it) | SSE/WS fan-out to frontend clients |
| Editor live preview | TypeScript + **WebGPU**, client-side | Must be instant on every slider drag; server round-trips can't hit that latency. Recipe is the only thing that ever leaves the browser during editing. Needs a lower-fidelity fallback for browsers without WebGPU support. Concrete implementation: `apps/web/src/lib/preview/` — dual WebGPU/WebGL2 renderers behind one `PreviewRenderer` interface, runtime capability detection, shared fit-geometry math (`docs/tasks/TASK-preview-renderer.md`). |
| Final export / batch render | Go | Same recipe, executed server-side at full resolution for export and for applying to many files — one execution engine backs both the live preview (approximately) and the ground-truth output (exactly). |

## Requirements

### P0 — Must Have
- Upload via presigned URL directly to object storage (no proxying large files through the API).
- Define and run a pipeline (JSON/YAML) with at least 2 chained steps.
- Built-in processors: image resize/convert/compress, video transcode/compress via ffmpeg, audio extraction/convert.
- Job state machine with per-step status persisted in Postgres.
- Real-time progress via SSE/WebSocket, driven off the same event stream used for job dispatch.
- Horizontally scalable Go worker pool (run N replicas, jobs distribute automatically).
- **Editor: non-destructive recipe model** — crop, light, color, filter adjustments stored as parameters, never pixel mutations; full undo/redo from recipe history.
- **Editor: live client-side preview** via WebGL/WebGPU — adjustments render in-browser with no per-slider server call.
- **Editor: curated composite controls** (Light, Color, B&W, Sharpen or equivalent) as the primary surface, with raw parameters tucked behind "Adjust manually."
- **Editor: export produces the same recipe format Plexus pipelines consume** — no separate "convert my edit into a pipeline" step.

### P1 — Nice to Have
- External plugin support via gRPC with a runtime plugin registry (register a plugin's address + supported processor types).
- Retry/backoff + dead-letter handling for failed steps.
- Pipeline templates/presets in the UI ("optimize for web", "podcast audio prep") — shared mechanism with editor presets.
- OpenTelemetry tracing across orchestrator + workers (nice for demonstrating you can debug a distributed system, not just build one).
- **Editor: presets as the primary entry point** — "pick a look" before "open blank editor," each preset a starter recipe.
- **Editor: "Apply to batch"** — take a recipe built on one image and run it as a pipeline against many files via the Go backend.

### P2 — Future Considerations
- Visual DAG builder in the frontend.
- WASM-sandboxed plugins (via `wazero` in Go) as a safer alternative to gRPC plugins for untrusted third-party code.
- Multi-tenant quotas/billing.
- Resumable/chunked uploads (tus protocol) for very large files.
- **Editor: intent-based editing** — natural-language or single-tap intent ("make this pop") mapped to a generated recipe, no manual sliders required.
- **Editor: inline contextual editing** — lightweight adjustments directly on thumbnails in gallery/batch views, without navigating to the full editor page.
- **Editor: professional RAW support** — camera RAW formats, lens correction profiles.

## User Stories

- As a user, I want to upload a file and pick a pipeline preset so that I don't have to hand-write a DAG for common tasks.
- As a user, I want to watch each step of my pipeline progress live so that I know whether a long job is stuck or just slow.
- As a power user, I want to define a custom multi-step pipeline in YAML so that I can chain transformations the presets don't cover.
- As a developer (future-you), I want to register a new processor as an external gRPC plugin so that I can add support for a new file type without redeploying the core system.
- As a developer, I want workers to scale horizontally so that a burst of large video jobs doesn't block small image jobs.
- As a casual user, I want to edit a photo with instant visual feedback so that editing feels responsive, not like waiting on a server.
- As a casual user, I want a handful of clearly-named controls (not raw technical parameters) so that I can get a good result without understanding what any of them "really" do.
- As a user, I want to pick a preset look before deciding whether I need to fine-tune anything so that most of the time I don't have to touch a single slider.
- As a user, I want to perfect an edit on one photo and apply the exact same edit to the rest of my batch so that I don't repeat manual work across many files.
- As a user, I want to make quick adjustments directly on a thumbnail without leaving the gallery so that small touch-ups don't require a page navigation.

## Success Metrics (portfolio-oriented, not business)

- **Throughput**: sustained jobs/minute at N worker replicas (benchmark and document — this becomes a legitimate portfolio talking point).
- **Latency**: time-to-first-progress-event after upload (proves the realtime path works, not just the batch path).
- **Extensibility proof**: successfully add one processor as an external plugin *without modifying core worker code* — this is the concrete demonstration that the architecture goal was actually met.
- **Failure handling**: a killed worker mid-job doesn't lose the job (it's picked up by another replica) — demonstrate this explicitly.
- **Preview latency**: time from slider input to updated preview frame (target: sub-frame, no perceptible lag — this is the metric that determines whether the editor "feels like Apple Photos" or not).
- **Recipe fidelity**: exported/full-resolution output matches the live preview closely enough that there are no surprises on export — measure and document any drift between the WebGL approximation and the Go ground-truth render.
- **Reuse proof**: a recipe built by hand on one image successfully runs unmodified as a batch pipeline across many files — the concrete demonstration that the editor and the pipeline engine are actually unified, not just similar.

## Open Questions

- Plugin sandboxing: is gRPC-only sufficient for v1, or is WASM worth pulling into P0 given it's more technically interesting? (leaning P2, but worth revisiting once gRPC plumbing is done)
- Object storage: self-hosted MinIO (more infra to manage, more "real") vs. a managed S3-compatible service (less yak-shaving)?
- Auth: reuse your existing auth patterns from Markado/the video converter, or is this a chance to try something new (e.g. OAuth device flow for a future CLI client)?
- Fallback path: **resolved 2026-08-06, see `docs/90-deferred-register.md` V-1.** WebGPU is solid on Chrome/Edge (default-on since Chrome 113 on Mac/Windows/ChromeOS) and on current-OS Safari, but **Firefox lacks default support on most of its platforms today** (Windows/macOS-Apple-Silicon only, both recent; Linux/Android still in development per the WebGPU standards group's own implementation-status tracker) — this is a live, current-version mainstream-browser gap, not just "older browsers/devices" as originally framed. Decision: the Canvas2D/WebGL2 fallback preview is a **first-class, parallel implementation** built alongside the WebGPU path from the start of Phase 2 preview work, not a rare-case stub — both consume the same recipe data structure, only the rendering backend differs.
- How much drift is acceptable between the WebGL live-preview approximation and the Go full-resolution render? Some filters may not be feasible to replicate exactly in a fragment shader — decide early which composite controls need pixel-identical parity vs. "close enough."
- Which composite sliders (Light, Color, B&W, Sharpen, etc.) and what underlying parameters each one maps to — **partially resolved 2026-08-07, see `docs/tasks/TASK-composite-slider-mapping.md` and `docs/90-deferred-register.md` D-19.** Four processor ids decided (`image.adjustLight`, `image.adjustColor`, `image.blackAndWhite`, `image.sharpen`) with a P0 param subset mapped to concrete govips calls. Highlights/Shadows resolved 2026-08-07 (`docs/tasks/TASK-highlights-shadows-tonelut.md`, `V-7`) — implemented Go-side via a local govips fork (`D-24`); live-preview/editor-UI parity for the two params remains open (`D-25`). Vibrance/Cast/Grain primitives researched 2026-08-07 (`docs/tasks/TASK-vibrance-cast-grain-spike.md`, resolved `V-8`): Cast is unblocked (grey-world algorithm from existing `Stats`/`Linear` primitives, `D-27`); Grain needs a small govips-fork extension mirroring `D-24`'s `Tonelut` precedent (`D-28`); Vibrance's exact curve has no primary-source-correct answer and stays a visual judgment call (`D-29`, folded into `D-22`'s tuning pass). Still open: the composite-slider-to-raw-parameter blend ratios themselves (visual tuning, not a backend question, `D-22`) and the remaining shader/UI implementation.

## Suggested Phasing

1. **Phase 1 — Core pipeline engine**: Orchestrator + single Go worker type + Postgres + NATS. Linear (non-branching) pipelines only. Built-in processors: resize, convert, compress.
2. **Phase 2 — Editor MVP**: Single-image editor — recipe model, WebGL live preview, curated composite sliders, export. No batch integration yet; this phase proves the UX goal stands on its own.
3. **Phase 3 — Real DAGs + realtime + Apply to Batch**: Branching/parallel steps, SSE progress stream, presigned upload flow, and wiring the editor's recipe into the pipeline engine so "apply to batch" actually works — this is where the two halves of the project fuse.
4. **Phase 4 — Plugin system**: gRPC plugin contract + registry, one real external plugin as proof of concept.
5. **Phase 5 — Polish/scale story**: autoscaling workers, OpenTelemetry tracing, throughput benchmarks, retry/dead-letter handling, editor presets, inline contextual editing.

Each phase is independently demoable — you don't need to reach Phase 5 for this to already be a stronger portfolio piece than a single-purpose converter. Phase 2 in particular is worth treating as its own milestone: a genuinely good single-image editor is a legitimate, shippable thing on its own, before any pipeline integration exists.
