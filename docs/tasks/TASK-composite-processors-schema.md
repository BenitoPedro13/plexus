# TASK-composite-processors-schema — Zod schema for the four P0 composite processors (Phase 2)

## Cenário actual

`apps/web/src/lib/recipe/schema.ts` defines `imageProcessorId` as exactly three values
(`image.resize`, `image.convert`, `image.compress`) and a matching three-branch
`recipeStepSchema` discriminated union. `TASK-composite-slider-mapping.md` (Phase 2, `D-6`,
committed `3be3a0c`) designed four new processor ids — `image.adjustLight`,
`image.adjustColor`, `image.blackAndWhite`, `image.sharpen` — each with a P0 param subset
mapped to a concrete govips call, but explicitly left `schema.ts` untouched ("next task,
once this design is reviewed"). This is tracked as `D-19` in `docs/90-deferred-register.md`,
whose own re-evaluation trigger reads: "Next task: extend
`apps/web/src/lib/recipe/schema.ts` with the P0 processors/params."

Today, re-verified directly against Apple's live docs
([Adjust light, exposure, and color](https://support.apple.com/guide/photos/adjust-light-exposure-and-color-pht806aea6a6/mac),
[Sharpen a photo or video](https://support.apple.com/guide/photos/sharpen-a-photo-phtba5e3cf7d/mac),
both fetched 2026-08-07 for this task): the four groupings and P0 param subset from
`TASK-composite-slider-mapping.md` still match exactly what's published — nothing had gone
stale. No schema change is needed to the *mapping decision* itself, only to encode it.

## Mudanças planeadas

Extends `apps/web/src/lib/recipe/schema.ts` with four new Zod object schemas and their
discriminated-union branches, one per processor id, P0 params only (deferred params —
`brilliance`/`highlights`/`shadows`, `vibrance`/`cast`, `grain`, `edges`/`falloff` — stay
out per `TASK-composite-slider-mapping.md`'s own rule: no schema field without a backing Go
processor).

- `apps/web/src/lib/recipe/schema.ts`:
  - `imageProcessorId` enum gains `'image.adjustLight'`, `'image.adjustColor'`,
    `'image.blackAndWhite'`, `'image.sharpen'`.
  - `adjustLightParamsSchema`: `exposure` (−3.0…3.0), `brightness` (−1.0…1.0), `contrast`
    (−1.0…1.0), `blackPoint` (0.0…1.0) — all `z.number()`, ranges from the mapping task's
    table, no defaults (Light starts as a no-op recipe step only when explicitly added by
    the editor UI, not implicitly present).
  - `adjustColorParamsSchema`: `saturation` (−1.0…1.0).
  - `blackAndWhiteParamsSchema`: `intensity` (0.0…1.0), `neutrals` (−1.0…1.0), `tone`
    (−1.0…1.0).
  - `sharpenParamsSchema`: `intensity` (0.0…1.0).
  - Four new branches added to `recipeStepSchema`'s discriminated union, same shape as the
    three existing branches (`id`, `processor` literal, `params`).
  - Each new schema gets a one-line comment pointing at
    `TASK-composite-slider-mapping.md`'s param table, mirroring how the three existing
    schemas point at their Go processor doc comments — there is no Go processor yet to
    point at (that's the next follow-on task per `D-19`), so the comment cites the design
    doc instead.
- `apps/web/src/lib/recipe/schema.test.ts`: round-trip and range-boundary tests for each of
  the four new schemas, following the existing `resizeParamsSchema`/`convertParamsSchema`/
  `compressParamsSchema` test pattern (requires-field checks, out-of-range rejection at both
  ends, defaults where applicable — none of the four P0 param sets has a default per the
  mapping table, unlike `convert`'s `quality`). Extend the `recipeSchema` round-trip test to
  include at least one step of each new processor type.

Not changed: `workers/internal/processors/` (no Go implementation yet — schema-only slice,
per `D-19`), the WebGPU/WebGL2 shaders, the orchestrator's `BUILTIN_PROCESSORS` (these four
ids are editor-only per the mapping task's scope; batch/orchestrator wiring is Phase 3 per
`D-17`).

## Porquê

`D-19` names this as the explicit next step, and it's the smallest unblocked slice of that
follow-on work — encoding a design that's already been reviewed and grounded (re-confirmed
today against Apple's current docs, not just trusted from the prior commit) into the type
that the editor UI, the live-preview renderer, and eventually the Go processors all need to
agree on. Doing the schema first (rather than jumping straight to Go processors or shaders)
matches the layering the rest of `apps/web/src/lib/recipe/` already has: the schema is the
one place both the future composite-slider UI component and the future preview shader read
their param shape from, so it has to exist before either can be built without guessing at
field names. Keeping deferred params (`highlights`/`shadows`/`vibrance`/`cast`/`grain`/
`edges`/`falloff`) out of the schema, per the mapping task's own rule, avoids shipping a
field with no reader — a half-finished implementation CLAUDE.md already forbids.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `docs/tasks/TASK-composite-processors-schema.md` | new | this document |
| `apps/web/src/lib/recipe/schema.ts` | edit | add 4 processor ids, 4 param schemas, 4 discriminated-union branches |
| `apps/web/src/lib/recipe/schema.test.ts` | edit | round-trip + range tests for the 4 new schemas; extend recipe round-trip test |
| `docs/90-deferred-register.md` | edit | update `D-19`: schema slice done, Go processors/shaders still open |
