# Deferred Register

Living document per `CLAUDE.md` §0/§3.1: every unverified claim (`V-xx`) and deliberate
debt/postponement (`D-xx`) discovered during implementation lives here, ranked by
consequence within each list. Created in the same pass as
`docs/tasks/TASK-scaffold-monorepo.md`, the first task to postpone anything.

Update this file in the same pass that resolves an item — move it to "Resolved" with the
date and what was decided, don't just delete it.

## V-xx — Unverified claims

| ID | Claim | Where it matters | Re-evaluation trigger |
|----|-------|-------------------|------------------------|
| V-1 | WebGPU has "~80%+ global browser support as of 2026," solid enough to build the editor preview directly on it, per spec §"Open Questions." This was true of general WebGPU rollout as of the spec's writing but has not been re-checked against current caniuse/browser release notes. | Phase 2 (Editor MVP) — determines whether the WebGPU-first design holds or the Canvas2D/WebGL fallback needs to be first-class rather than a rare-case escape hatch. | Before starting Phase 2 editor implementation — re-verify current WebGPU support (Chrome/Firefox/Safari stable channels) directly, not from this note. |
| V-2 | How much drift is acceptable between the WebGL/WebGPU live-preview approximation and the Go full-resolution render is undecided — spec flags some filters may not be feasible to replicate exactly in a fragment shader. | Phase 2/3 — the spec's own "Recipe fidelity" success metric requires a *numeric* bound per composite control (CLAUDE.md §0 Tests), not a vague "close enough." | Before implementing the first composite control (Light/Color/B&W/Sharpen) — needs a bound decided per control, not globally, likely its own small task doc. |

## D-xx — Deliberate debt / postponements

| ID | Decision | Why deferred | Re-evaluation trigger |
|----|----------|---------------|-------------------------|
| D-1 | `apps/web` (Next.js editor), `proto/` (gRPC plugin contract), `packages/` (shared TS types) were **not** scaffolded in `TASK-scaffold-monorepo.md`, even though CLAUDE.md §4 proposes them as part of the eventual layout. | Phase 1 (spec's phasing) only needs the orchestrator and one Go worker type. Scaffolding the editor/proto/shared-package boilerplate now risks it drifting stale (framework versions moving on, per CLAUDE.md §2.0) before Phase 2/3/4 actually touch it. | Start of the task doc for the phase that needs each: `apps/web` at Phase 2 start, `proto/` at Phase 4 start (or earlier if Phase 3's "Apply to Batch" needs the recipe/pipeline contract formalized sooner), `packages/` whenever the first genuinely shared TS type appears (e.g. the Edit Recipe / Pipeline schema, likely Phase 3). |
| D-2 | Root `package.json`'s `packageManager` field is pinned to `pnpm@11.5.2` (what was actually installed locally via nvm/corepack at scaffold time), not the `pnpm@11.14.x` line identified as current-stable during CLAUDE.md §2.0 research. | Both are the same major (pnpm 11) with no workspace-schema-breaking differences found during scaffolding; forcing a corepack download of a newer patch mid-scaffold added risk for no functional benefit. | Low urgency — revisit opportunistically, or immediately if a pnpm 11.14+-only feature (e.g. `pnpm doctor`, `pnpm lane`) becomes useful. |
| D-3 | Object storage choice (self-hosted MinIO vs. managed S3-compatible) — spec §"Open Questions," not resolved by this scaffold. | Not needed until Phase 3 (presigned upload flow) per spec's phasing; Phase 1's linear pipelines don't require object storage wiring yet. | Start of the Phase 3 task doc that implements presigned upload. |
| D-4 | Auth approach (reuse existing patterns vs. OAuth device flow) — spec §"Open Questions," not resolved by this scaffold. | Phase 1 (orchestrator + worker + Postgres + NATS, linear pipelines) has no user-facing auth surface yet per the spec's phasing. | Before any orchestrator endpoint needs to be gated — likely Phase 3 (realtime/SSE to specific users) or whenever multi-user access is first exercised. |
| D-5 | Plugin sandboxing tier (gRPC-only for v1 vs. pulling WASM/`wazero` into P0) — spec §"Open Questions," leaning P2 per the spec itself. | No plugin work happens before Phase 4. | Once the gRPC plugin contract (`proto/`) plumbing exists and a second/untrusted plugin author scenario is concretely being designed for (per the spec's own note: "worth revisiting once gRPC plumbing is done"). |
| D-6 | Composite-slider (Light, Color, B&W, Sharpen) → underlying recipe parameter mapping — spec §"Open Questions," explicitly needs its own design pass. | Not needed until Phase 2 editor work begins. | Before Phase 2 editor implementation starts; likely warrants its own `TASK-composite-slider-mapping.md` design doc before any editor UI code is written. |

## Resolved

| ID | Was | Resolved | Date |
|----|-----|----------|------|
| — | TypeScript package manager choice (open per CLAUDE.md §4, "chosen at scaffold time") | **pnpm** — matches CLAUDE.md's own examples, first-class workspace support for `apps/*`+`packages/*` layout. | 2026-08-06 (`TASK-scaffold-monorepo.md`) |
| — | Go module import path pending confirmation of GitHub owner (`[VERIFY]` in `TASK-scaffold-monorepo.md`) | `github.com/benitopedro13/plexus/workers` — confirmed by user. | 2026-08-06 |
| — | pnpm's minimum supported Node.js major for the pinned v11 line (`[VERIFY]` in `TASK-scaffold-monorepo.md`) | pnpm 11 requires Node.js ≥22; repo pins `.nvmrc` to Node 24 (Active LTS, matches locally installed toolchain). | 2026-08-06 |
