# Plexus editor (apps/web)

Next.js frontend — the non-destructive, Apple-Photos-style image editor described in the
root [`README.md`](../../README.md) and
[`docs/plexus-media-pipeline-spec.md`](../../docs/plexus-media-pipeline-spec.md). Every
adjustment writes recipe parameters; nothing is ever applied to pixels until export.

## Pages

| Route | Purpose |
|---|---|
| `/editor` | The primary editor surface — drop/select a photo, adjust via curated Light/Color/Black & White/Sharpen/Crop controls, undo/redo, export |
| `/preview-demo` | Renderer smoke-test harness — raw per-parameter controls against the `PreviewRenderer` (WebGPU/WebGL2) directly, not the curated editor UI |

## Live preview

`src/lib/preview/` implements two renderers (`WebGPURenderer`, `WebGL2Renderer`) behind one
`PreviewRenderer` interface, with runtime `navigator.gpu` feature detection choosing which
one runs. Both consume the same `Recipe` and apply its steps in true recipe order — no
translation step between what the editor shows and what `workers/`'s Go renderer later
produces at export.

## Env vars

```sh
cp .env.example .env.local
```

`NEXT_PUBLIC_ORCHESTRATOR_URL` — base URL of `apps/orchestrator`'s API, used by
`src/lib/editor/export.ts` to `POST /export`. Next.js only loads env files from this app's
own directory, not the monorepo root's `.env.example` (that one is infra-only:
orchestrator/worker vars).

## Run

```sh
pnpm install
pnpm dev
```

Open [http://localhost:3000/editor](http://localhost:3000/editor). Export requires a
running `apps/orchestrator` and `workers/cmd/renderserver` (see their own READMEs).

## Test

```sh
pnpm test        # vitest — pure logic + DOM-level tests, no browser/GPU required
pnpm lint
```

Shader source itself (WGSL/GLSL) isn't exercised by this suite — see
`docs/90-deferred-register.md` `D-34` for what that gap has already caused and the
mitigation plan.
