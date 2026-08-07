# TASK-editor-composite-ui — Curated composite-slider editor UI (Phase 2, D-19/D-6)

## Cenário actual

`apps/web/src/app/preview-demo/page.tsx` is the only page exercising the live-preview
renderer today. Per its own header comment it is "deliberately unstyled, not the real
editor UI" — every one of the seven P0 composite params (`exposure`, `brightness`,
`contrast`, `blackPoint`, `saturation`, B&W's `intensity`/`neutrals`/`tone`, sharpen's
`intensity`) is exposed as its own raw range input, with no grouping into the spec's
"Light / Color / B&W / Sharpen" vocabulary and no way to hide the raw params behind a
curated control. Undo/redo does not exist anywhere — `page.tsx`'s state is a flat set of
`useState` calls with no history.

This leaves two P0 requirements from `docs/plexus-media-pipeline-spec.md`'s Requirements
section unmet:

- "Editor: curated composite controls (Light, Color, B&W, Sharpen or equivalent) as the
  primary surface, with raw parameters tucked behind 'Adjust manually.'"
- "Editor: non-destructive recipe model — ... full undo/redo from recipe history."

`docs/90-deferred-register.md` `D-19` tracks this as the next task after the Go
processors and preview shaders landed: "blend-ratio UI tuning and D-6's real
curated-slider editor UI." `TASK-composite-slider-mapping.md`'s "Explicitly out of scope"
section already decided blend-ratio tuning is *this* task's job, not a separate design
doc — it's "editor-UI-only ... tuned against real images at that point," never leaving the
browser as a value (the recipe only ever stores the raw params).

## Mudanças planeadas

### Which groups actually need a fan-out blend ratio

Re-reading `TASK-composite-slider-mapping.md`'s own Apple-support-page research (not
re-verified here, just applied): only **Light** is a single top slider that fans into
multiple raw params in Apple's real UI (Exposure/Brightness/Contrast/Black Point, P0
subset of the seven Apple exposes). **Color** has exactly one P0 param (`saturation` —
Vibrance/Cast are `V-8`-blocked) so it *is* already the raw param, 1:1. **B&W** and
**Sharpen** are their own direct panes in Apple's real design, not fan-out composites —
B&W's Intensity/Neutrals/Tone are three sliders Apple shows directly, not one master
slider synthesizing three. So only Light gets a real "composite value → several params"
mapping; Color/B&W/Sharpen get direct, correctly-scoped controls instead of an invented
fan-out nobody asked for.

### Light's blend ratios (the one genuine judgment call)

`t ∈ [-1, 1]`, default `0`, in `apps/web/src/lib/editor/light-blend.ts` (new):

```
exposure    = t * 1.5        // half of exposure's -3..3 range
brightness  = t * 0.3
contrast    = t * 0.25
blackPoint  = t < 0 ? -t * 0.3 : 0   // only darkening deepens blacks
```

Explicitly **not** a claim about Apple's internal curve (closed-source, unverifiable) —
this is the "drag against a real photo and eyeball it" judgment call
`TASK-composite-slider-mapping.md` deferred to this task. Documented here instead of
asserted with false precision, per `CLAUDE.md` §0.

**One-directional by design.** The master Light slider is a *write* control: dragging it
recomputes all four raw params via the formula above, same target params the "Adjust
manually" raw sliders write directly. It does not attempt to *read back* a position from
arbitrary raw-param values after a manual tweak — that would need an invented inverse
(the four params aren't guaranteed proportional once a user hand-edits one). The master
slider's own displayed position is local component state, independent of the raw params'
current values; this mirrors Apple's own master/detail sliders both targeting the same
underlying values without one being a strict function of the other.

### New files

- **`apps/web/src/lib/editor/light-blend.ts`** — `applyLightBlend(t: number):
  AdjustLightParams`, the formula above, plus its inverse-free comment. Unit-tested
  (`light-blend.test.ts`) for the four documented ratios at `t = -1, 0, 1`.
- **`apps/web/src/lib/editor/history.ts`** — `useRecipeHistory<T>(initial: T)`: a small
  `{ past: T[]; present: T; future: T[] }` reducer hook (`commit(next: T)`, `undo()`,
  `redo()`, `canUndo`, `canRedo`). `T` here is the flat edit-state shape (light params,
  saturation, bw-enabled + params, sharpen intensity), not the assembled `Recipe` —
  assembling `Recipe` from edit-state is a pure derivation, done in the page, so history
  doesn't need to know about processor ids at all.
- **`apps/web/src/components/editor/LightControl.tsx`** — master slider + "Adjust
  manually" `<details>` disclosure revealing the four raw sliders (exposure/
  brightness/contrast/blackPoint), each with its own labeled range + numeric readout,
  matching the existing raw-slider look in `preview-demo`.
- **`apps/web/src/components/editor/ColorControl.tsx`** — single Saturation slider
  (already the raw param — no manual toggle needed, nothing to tuck away).
  **`apps/web/src/components/editor/BlackAndWhiteControl.tsx`** — enable toggle (checkbox)
  + Intensity/Neutrals/Tone sliders, all shown directly (matches Apple's real pane; no
  invented fan-out per the "which groups" section above). When disabled, the
  `image.blackAndWhite` step is omitted from the recipe entirely — B&W is a distinct
  look being turned on/off, not a slider parked at an identity value — rather than
  emitted at `intensity=0`.
- **`apps/web/src/components/editor/SharpenControl.tsx`** — single Intensity slider.
- **`apps/web/src/app/editor/page.tsx`** — the real editor route. Composes the four
  control components + `PreviewCanvas`, owns edit-state via `useRecipeHistory`, derives
  `Recipe` from edit-state (only including a composite step when its params differ from
  identity — keeps hand-edited recipes minimal, same spirit as the B&W toggle), commits a
  history entry on drag-release (`onPointerUp`/`onTouchEnd` on each control's wrapper, not
  on every `onChange` — otherwise every dragged pixel would be its own undo step) not on
  every `onChange`, and wires `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` keyboard shortcuts plus
  visible Undo/Redo buttons. Also carries the existing width/height/fit resize controls
  (unchanged from `preview-demo`) since resize is already part of the recipe and the new
  page replaces `preview-demo` as the primary surface.

### Existing files, unchanged

`preview-demo/page.tsx` stays as-is — it's the renderer smoke-test harness
(`TASK-preview-renderer.md`'s own framing), useful for exercising the raw params
independent of any blend-ratio/history logic layered on top. `PreviewCanvas`,
`lib/preview/*`, `lib/recipe/schema.ts` are all consumed unchanged; this task is UI-only,
no processor/schema/shader changes.

### Explicitly out of scope (new deferred items)

- **Presets** ("pick a look" before blank editor) — P1 in the spec, separate task.
- **Crop** — spec mentions it in the same P0 bullet as light/color/filter, but no
  `image.crop` processor/schema/Go implementation exists yet; not invented here.
- **"Adjust manually" for Color/B&W/Sharpen** — not applicable, see "which groups" above;
  noting explicitly so it doesn't read as a missed spot.
- **Persisting recipe history across reloads / naming/saving a recipe** — undo/redo is
  in-memory only for this task, matching "full undo/redo from recipe history" literally
  without also building save/load (no requirement asked for that yet).

## Porquê

Phase 2 (per the spec's phasing) is "independently demoable... a genuinely good
single-image editor is a legitimate, shippable thing on its own." Two of its four P0
editor bullets — curated composite controls, and undo/redo — are still unmet even though
every backend/rendering piece they depend on (processors, schema, shaders, drift
bounds) landed already. This task is the one that actually makes the editor *feel* like
the spec's Apple Photos bar instead of a parameter-testing harness. Scoping the blend-ratio
design down to "only Light needs one" (rather than inventing fan-out ratios for Color/B&W/
Sharpen that Apple's own UI doesn't have either, per the mapping doc's own research) keeps
this grounded instead of speculative — consistent with `CLAUDE.md` §0's "never invent...
without verification," applied here to *not* inventing a composite structure the primary
source doesn't support, even though the blend-ratio numbers themselves are an acknowledged,
explicitly-scoped judgment call.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/lib/editor/light-blend.ts` | new | `t -> {exposure, brightness, contrast, blackPoint}` formula |
| `apps/web/src/lib/editor/light-blend.test.ts` | new | asserts the four ratios at `t = -1, 0, 1` |
| `apps/web/src/lib/editor/history.ts` | new | `useRecipeHistory` past/present/future reducer hook |
| `apps/web/src/lib/editor/history.test.ts` | new | commit/undo/redo/canUndo/canRedo behavior |
| `apps/web/src/components/editor/LightControl.tsx` | new | master slider + manual disclosure |
| `apps/web/src/components/editor/ColorControl.tsx` | new | direct saturation slider |
| `apps/web/src/components/editor/BlackAndWhiteControl.tsx` | new | enable toggle + 3 direct sliders |
| `apps/web/src/components/editor/SharpenControl.tsx` | new | direct intensity slider |
| `apps/web/src/app/editor/page.tsx` | new | real editor route: state, history, recipe derivation, keyboard shortcuts |
| `docs/90-deferred-register.md` | edit | resolve `D-19`'s "still not implemented" clause; note new out-of-scope items (crop, presets) if not already tracked |
