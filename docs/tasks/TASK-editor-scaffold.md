# TASK-editor-scaffold

## Cenário actual

Phase 1 (Core pipeline engine) is complete and CI-enforced as of `8c8dc1f`: orchestrator,
Go worker pool, NATS dispatch, built-in image/video/audio processors, CI, and a worker
Docker image all exist under `apps/orchestrator/` and `workers/`. `apps/web` does not
exist — `docs/90-deferred-register.md`'s **D-1** explicitly deferred it, with the
re-evaluation trigger "start of the task doc for the phase that needs it: `apps/web` at
Phase 2 start." That trigger is now met per the spec's Suggested Phasing (Phase 2 —
Editor MVP is next) and the user's explicit choice this session to start Phase 2 planning.

Two open items block writing any editor code, not just the scaffold:

- **V-1** (deferred register): the spec's Open Questions claim that "WebGPU now ships by
  default across Chrome, Firefox, and Safari (as of 2026), putting it in the ~80%+ global
  support range — solid enough to build on directly" was flagged as unverified, with its
  own re-evaluation trigger being "before starting Phase 2 editor implementation."
- **D-6**: composite-slider (Light/Color/B&W/Sharpen) → parameter mapping needs its own
  design pass before any editor UI code is written. Out of scope for *this* task — tracked
  as a follow-up task doc, not resolved here.

This task closes V-1 and scaffolds `apps/web`. It does not touch editor logic, WebGPU
code, or composite sliders — those are follow-up task docs, mirroring how Phase 1 was five
separate incremental task docs rather than one large pass.

## Mudanças planeadas

### 1. Resolve V-1 — re-verify WebGPU support against primary sources (not memory)

Checked this session, dated 2026-08-06:

- **MDN** (`developer.mozilla.org/.../WebGPU_API`): explicit "Limited availability — this
  feature is not Baseline because it does not work in some of the most widely-used
  browsers."
- **caniuse.com** per-browser latest-stable table: Chrome 154 ✅ supported, Edge 151 ✅
  supported, **Firefox 156 ❌ disabled by default**, **Safari 18.7 ❌ disabled by
  default**. Global figure reported as ~83.6%, which is inconsistent with Firefox/Safari
  both being off — likely blending partial/flagged availability into the headline number
  the same way the spec's original "~80%+" figure did.
- **gpuweb implementation-status wiki** (`github.com/gpuweb/gpuweb/wiki`, the WebGPU
  standards group's own tracking page): Chrome/Chromium default-on since v113 on
  Mac/Windows/ChromeOS (Linux needs recent GPU + drivers or a flag); **Firefox default-on
  on Windows only (v141+) and macOS Apple Silicon (v145+) — Linux and Android still in
  development**; **Safari default-on since Safari 26** (macOS Tahoe 26 / iOS 26 / iPadOS 26
  / visionOS 26).

**Finding:** the spec's framing ("ships by default across Chrome, Firefox, and Safari...
solid enough to build on directly") does not hold today. Chrome/Edge are solid. Safari is
plausibly solid on current OS versions (Safari 26) per the standards group's own tracker,
but that conflicts with caniuse showing "Safari 18.7" as the latest stable and disabled —
almost certainly caniuse lagging Apple's 2025 OS-year renumbering (Safari 18.x → 26) rather
than a real capability gap, but not confirmed against a primary Apple/WebKit source in this
pass. **Firefox is the clear, current gap**: no default support on Linux or Android, and
even Windows/macOS support is recent (2026) and platform-conditional. This isn't "older
browsers/devices" as the spec's Open Question framed it — it's a live, current-version
mainstream browser missing support on most of its platforms today.

**Decision:** the Canvas2D/WebGL2 fallback preview path is promoted to a first-class,
parallel implementation built alongside the WebGPU path from the start of editor preview
work (Phase 2, later task doc) — not a stubbed "your browser doesn't support the fast
editor yet" message treated as a rare case. Both paths consume the same recipe data
structure; only the rendering backend differs. This decision is recorded here and reflected
in the spec (below) since it changes how Phase 2's preview-rendering task doc should scope
its own work.

### 2. `docs/plexus-media-pipeline-spec.md` — correct the Open Questions fallback bullet

Replace the stale "~80%+ global support... solid enough to build on directly" framing
(written at spec-authoring time, not re-checked since) with the verified 2026-08-06 finding
above and the resulting decision (fallback is first-class, not a rare-case escape hatch).
Per CLAUDE.md §1/§3.1, resolving an open question updates the spec directly rather than
just leaving a note in the deferred register.

### 3. `docs/90-deferred-register.md`

- Move **V-1** to Resolved with the finding and date.
- Add **V-5**: the caniuse-vs-gpuweb-wiki discrepancy on Safari's current WebGPU-by-default
  status (caniuse: "Safari 18.7, disabled" vs. gpuweb wiki: "default-on since Safari 26") is
  not fully reconciled — plausibly explained by Apple's 2025 OS-year version renumbering
  confusing caniuse's tracking, but not confirmed against a primary Apple/WebKit source.
  Matters because it determines what fraction of Safari users actually need the fallback.
  Re-evaluation trigger: before the WebGPU/WebGL preview task doc finalizes its
  feature-detection + fallback-routing logic — check `webkit.org/blog` or Apple's own Safari
  26 release notes directly.
- Update **D-1**: close the `apps/web` portion (scaffolded by this task); `proto/` and
  `packages/` remain open, unchanged triggers (Phase 4 start, first shared TS type
  respectively).

### 4. `apps/web/` (new) — Next.js, scaffolded via CLI

- Version verified this session: **Next.js 16.3**, current stable (released 2026-08-03 per
  the framework's own blog/release notes), matching CLAUDE.md §2.0's "always latest stable
  major" rule and superseding the "16.2.x" note left in `TASK-scaffold-monorepo.md` (that
  note was explicitly "not scaffolded this task, noted for Phase 2" — this is that phase).
- Run `pnpm create next-app@latest` from `apps/`, so the workspace's existing
  `pnpm-workspace.yaml` (`apps/*` + `packages/*`, from the original scaffold) picks it up
  with no reconfiguration.
- Exact CLI flags (TypeScript, App Router, Tailwind, ESLint, import alias, `src/` dir) are
  **not pinned here** — `[VERIFY: run `pnpm create next-app@latest --help` at execution
  time and use current CLI defaults/prompts per CLAUDE.md §2.0, rather than flags
  remembered from training data]**. TypeScript and App Router are non-negotiable (matches
  the rest of the stack and the spec's architecture diagram); Tailwind's inclusion is left
  to the CLI's current default unless it conflicts with the eventual WebGPU canvas/editor
  layout needs, which this scaffold-only task has no opinion on yet.
- No editor code, no WebGPU/WebGL canvas, no recipe UI, no composite sliders. This task
  proves `pnpm --filter web dev` boots a bare Next.js app inside the workspace — same bar
  `TASK-scaffold-monorepo.md` set for `apps/orchestrator` (`pnpm --filter orchestrator
  start:dev` boots a bare NestJS app).

### 5. `CLAUDE.md` — §4 layout table

`apps/web` moves from "proposed, Phase 2" to "scaffolded," matching how `apps/orchestrator`
and `workers/` were updated when they were scaffolded.

## Porquê

Phase 1's P0 scope is done and CI-enforced; Phase 2 (Editor MVP) is next per the spec's own
phasing and is called out explicitly as an independently shippable milestone worth treating
as its own portfolio piece. Before any editor code exists, the deferred register already
flagged (V-1) that the spec's WebGPU-support claim needed re-checking against current
sources before Phase 2 implementation starts — and it turned out to matter concretely:
primary sources (MDN's own Baseline classification, caniuse's per-browser table, and the
WebGPU standards group's own implementation-status tracker) show Firefox lacks default
support on most of its platforms today, which the spec's original "ships by default across
Chrome, Firefox, and Safari" framing missed. Deciding now — before the preview-rendering
task doc gets written — that the Canvas2D/WebGL2 fallback is a first-class parallel
implementation, not a rare-case stub, changes that later task's actual scope, so it belongs
in this task's decisions rather than being discovered mid-implementation.

Scaffolding `apps/web` now (closing D-1's editor portion) and stopping there — no editor
logic yet — follows the same incremental-slice pattern Phase 1 used (five separate,
independently reviewable task docs) rather than one large Phase 2 task attempting the
scaffold, the WebGPU pipeline, and the composite-slider design (D-6, still open) all at
once.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/**` | new | generated by `pnpm create next-app@latest`, Next.js 16.3 |
| `docs/plexus-media-pipeline-spec.md` | edit | Open Questions WebGPU-fallback bullet corrected with verified 2026-08-06 finding |
| `docs/90-deferred-register.md` | edit | V-1 → Resolved; new V-5 (Safari version-numbering discrepancy); D-1 updated (`apps/web` closed) |
| `CLAUDE.md` | edit | §4 layout table: `apps/web` proposed → scaffolded |
| `docs/tasks/TASK-editor-scaffold.md` | new | this document |
