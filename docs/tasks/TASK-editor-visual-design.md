# TASK-editor-visual-design

## Cenário actual

`apps/web/src/app/editor/page.tsx` and its five composite controls
(`apps/web/src/components/editor/{LightControl,ColorControl,BlackAndWhiteControl,
SharpenControl,CropControl}.tsx`) are functionally complete — Phase 2's full P0 list
closed with `TASK-editor-export.md`. Visually, none of it has had a design pass:

- The page is unstyled `create-next-app` scaffolding: raw `<fieldset><legend>` boxes,
  native `<input type="range">`/`<select>`/checkbox controls, inline `style={{...}}`
  objects for layout (`editor/page.tsx` lines 157–177), default black-on-white body text
  (`globals.css` still has the untouched `create-next-app` `--background`/`--foreground`
  tokens and `<title>Create Next App</title>` in `layout.tsx`).
- `PreviewCanvas.tsx` renders a bare `<canvas>` with a plain status paragraph below it; no
  frame, no sizing/centering behaviour beyond the renderer's own intrinsic
  `canvas.width`/`canvas.height` (set from output geometry, e.g. 400×400 by default —
  `webgl2-renderer.ts:732`, `webgpu-renderer.ts:720`).
- `CropControl.tsx`'s selection rect uses a hardcoded generic blue
  (`RECT_STROKE = '#3b82f6'`), unrelated to anything else on the page.
- There is no drag-and-drop; loading a photo means finding a tiny unstyled
  `<input type="file">` above the canvas.
- No component-level DOM tests exist anywhere in `apps/web/src` (confirmed: only
  `lib/**/*.test.ts` pure-logic tests, no `*.test.tsx`) — restyling/restructuring this
  markup has zero risk of breaking an existing test suite; all prop contracts
  (`value`/`onChange`/`onCommit`/`enabled`/`onEnabledChange`) stay load-bearing and unchanged.

Spec P0 bullet: "**Editor: curated composite controls** as the primary surface" and the
project brief's explicit bar — "an equally first-class image editor that must feel like
Apple Photos." Nothing about the current visual presentation clears that bar; it reads as
an internal debug harness, not a product.

## Mudanças planeadas

This is a visual/interaction-layer pass only — **no change to any control's props, to
`deriveRecipe()`, to `useRecipeHistory`, to any `lib/` module, or to what NATS/orchestrator/
worker sees.** Every existing `onChange`/`onCommit`/`value` contract is preserved exactly;
only how each control renders changes.

### Design direction

**Why dark, and why this isn't the generic "dark mode + one accent" default:** professional
photo/video tools (Lightroom, Photos' own edit view, Photoshop, DaVinci Resolve) run dark
chrome around the image for a real, non-aesthetic reason — a bright surrounding UI biases
how a human perceives the photo's actual exposure and color. That's the actual justification
for going dark here, not "dark mode looks premium." The accent color and type system are
chosen to make that concrete rather than generic: a **darkroom safelight** — the dim
amber-red light real darkrooms use because it's the one wavelength that doesn't fog
photographic paper — instead of a neon/SaaS accent, and slider geometry borrowed directly
from a manual camera's **exposure-compensation dial** (bipolar, zero-centered) rather than a
generic filled progress bar.

**Revised during implementation: built on shadcn/ui, not hand-rolled primitives.** The user
approved using shadcn if useful. `pnpm dlx shadcn@latest init` (preset `nova` — Lucide +
Geist, matching the fonts already loaded) and `add slider switch toggle-group label
separator input` were run in `apps/web`, per `CLAUDE.md` §2.0.3 (shadcn is CLI-pulled, not
a pinned dependency — checked live, current flags: `--base radix`, presets replaced the old
style/base-color pair). This gets Radix-backed keyboard/a11y semantics for free instead of
hand-styling native inputs, at the cost of shadcn's tokens being **global** by convention
(`:root`/`.dark` in `globals.css`, toggled by a `dark` class, not a scoped subtree) — fighting
that with a `.plx-editor`-scoped subset would work against the tool rather than with it. So
the palette below is written into `globals.css`'s `:root`/`.dark` (identical values in both;
this app has no light-mode toggle, `layout.tsx` forces the `dark` class) instead of a scoped
class. This does mean `apps/web/src/app/page.tsx` (the untouched `create-next-app` starter,
still unlinked from anywhere) and `preview-demo` now inherit the same dark palette too —
accepted as a reasonable side effect (a consistent dark theme app-wide, for free) rather
than fought, since neither page gets its own redesign in this task either way.

| Token | Hex | Use |
|---|---|---|
| `--px-ink` | `#16130F` | stage/page background — warm near-black, not blue-black |
| `--px-ink-raised` | `#201B15` | control rail surface, one step up from the stage |
| `--px-ink-sunken` | `#0F0D0A` | inset wells: readout windows, canvas frame recess, track backgrounds |
| `--px-paper` | `#F3ECE1` | primary text — warm off-white, like matte photo paper, never pure `#fff` |
| `--px-paper-dim` | `#948C7E` | secondary text: section labels, idle states, disabled |
| `--px-safelight` | `#E2551B` | the one accent: active fill, focus ring, Export button, exposure needle |

Since the tokens ended up global (see above), `PreviewCanvas.tsx` just uses the same
Tailwind utility classes (`border-border`, `bg-secondary`, `text-primary`, …) as everything
else — no inline-fallback indirection needed, and it reads correctly in both the editor and
the `preview-demo` smoke-test harness (explicitly out of scope for a redesign of its own).

**Type** — no new fonts. Both faces are already loaded (`layout.tsx`'s
`--font-geist-sans`/`--font-geist-mono`); the deliberate choice is *how* they're assigned:
- **Geist Mono** becomes the primary *instrument* voice — every section label, slider
  readout, and status badge is set in it, uppercase, tracked (`letter-spacing: 0.08em`),
  small (11–13px), tabular-nums for numbers. This is what makes it read as a light
  meter/camera-settings readout instead of a generic form.
- **Geist Sans** stays the *human* voice — button labels, empty-state copy, error text.

**Signature element — the instrument slider.** `apps/web/src/components/ui/slider.tsx`
(shadcn-generated, wrapping Radix's `Slider` primitive — keyboard stepping, drag, and ARIA
range semantics come from Radix, not hand-rolled) is edited, not replaced: simplified to
single-thumb only (every editor param is one number, never a `[lo, hi]` pair, so the
generator's multi-thumb `.map()` was dead weight), and given a `bipolar` prop. Radix's own
`Slider.Range` always fills from the **minimum**, which is wrong for a center-zero domain —
so bipolar mode swaps it for a manually-positioned fill `div` (computed from
`value`/`min`/`max`, not from Radix, which has no built-in center-origin fill) plus a
center-tick mark; unipolar mode keeps Radix's own `Range` unmodified, since "fill from the
left" is already correct when `min` is `0`. `apps/web/src/components/editor/ui/Slider.tsx`
(`InstrumentSlider`, new) wraps that primitive with the mono label + readout window every
control needs, used everywhere a slider appears:
- **Bipolar** (Exposure, Brightness, Contrast, Highlights, Shadows, Saturation, the Light
  master, Neutrals, Tone): fill grows from a **center zero tick**, like exposure
  compensation — matches these params' actual `-N..N` domain instead of the generic
  left-to-right fill that misrepresents "0" as "empty."
- **Unipolar** (Black Point, Cast, B&W Intensity/Grain, Sharpen): fills from the left,
  domain is genuinely `0..N`.
- Each has an inset `--px-ink-sunken` readout window to its right showing the signed value
  in mono tabular-nums, `--px-paper-dim` at identity/zero, `--px-safelight` once the value
  moves off identity — a control you've touched looks visibly different from one you
  haven't, at a glance, across the whole rail.

**Layout** (`editor/page.tsx` restructured, Tailwind utility classes replacing the inline
`style={{}}` objects):

```
┌───────────────────────────────────────────────────────────────────┐
│ PLEXUS · EDITOR                                 [Undo][Redo][Export]│ ← 48px top bar
├─────────────────────────────────────┬───────────────────────────────┤
│                                       │ RESIZE                       │
│                                       │ width [ ] height [ ]  ⬚ ⬛   │ ← segmented fit
│                                       ├───────────────────────────────┤
│         (photo on the stage,         │ CROP           (•) off       │
│          centered, --px-ink bg,      ├───────────────────────────────┤
│          soft frame + shadow)        │ LIGHT                        │
│                                       │  ⊢——●——⊣          +0.00      │
│  [WEBGPU]  ← status badge,           │  ▸ Adjust manually           │
│    top-right corner of the stage     ├───────────────────────────────┤
│                                       │ COLOR / CROP / B&W / SHARPEN │
│                                       │  (same instrument-slider     │
│                                       │   language)                  │
└─────────────────────────────────────┴───────────────────────────────┘
```

Right rail: fixed 320px, `--px-ink-raised`, hairline-divided sections (no boxed
`<fieldset>` borders) — reads like a settings list, not a stack of form boxes. Section
headers are the mono instrument label, not a native `<legend>`.

**Empty state — the dropzone.** Today: a bare `<input type="file">` floating above the
canvas. New: when no image is loaded, the stage renders a full-bleed dropzone — four small
`--px-paper-dim` corner brackets (photo-mount-corner motif, turning `--px-safelight` on
drag-over) framing centered mono copy "DROP A PHOTO, OR CLICK TO CHOOSE." The whole stage
area is one clickable/droppable target. This adds native `onDragOver`/`onDrop` handlers in
`editor/page.tsx` that call the **same** existing `handleFileChange` file-handling logic
(refactored to a shared `loadFile(file: File)` helper so both the `<input>`'s `onChange`
and the new `onDrop` call one path) — the only new *behavior* in this task, everything else
is presentational. `PreviewCanvas`'s own prop contract (`image`, `recipe`) is unchanged;
`editor/page.tsx` conditionally renders the dropzone **instead of** `<PreviewCanvas>` when
`image` is `null`, so `PreviewCanvas.tsx` itself only needs frame/status-badge restyling,
not new empty-state UI (keeping `preview-demo`, which renders `PreviewCanvas` with `image:
null` and relies on its own plain idle text, working exactly as before).

**Toggle switch** (Crop enabled, B&W enabled): shadcn's `Switch` (`add switch`, Radix
`Switch.Root`/`Thumb`) used directly, no wrapper — already themed correctly via the
`--primary`/`--input` tokens above, no custom component needed.

**Segmented control** (Resize `fit`: inside/cover): shadcn's `ToggleGroup`/`ToggleGroupItem`
(`add toggle-group`, `type="single"`) used directly — a two-way exclusive choice reads
better as a segmented control than a `<select>`, and Radix's `ToggleGroup` is the canonical
component for exactly this, not something worth hand-building.

**Crop selection rect**: `RECT_STROKE`/`RECT_FILL` in `CropControl.tsx` become
`--px-safelight` / a low-alpha safelight fill, replacing the unrelated generic blue.

### New files (`apps/web/src/components/editor/ui/`)

Kept to exactly the two the controls actually need beyond shadcn's own primitives:

- `Slider.tsx` (`InstrumentSlider`) — `{ label, value, min, max, step, bipolar?, identity?,
  disabled?, onChange, onCommit }`. Wraps `@/components/ui/slider`'s edited `Slider` (see
  above) with the mono uppercase label and the readout window (paper-dim at `identity`,
  safelight once touched).
- `Section.tsx` — `{ title, headerExtra?, children }`. The recurring rail-section chrome
  (mono label + hairline divider), replacing every `<fieldset><legend>` — real, not
  speculative, reuse: all five controls plus the Resize block needed the same wrapper.

Toggles and the fit selector use shadcn's `Switch`/`ToggleGroup` directly (no wrapper
needed — see above). Each existing control (`LightControl`, `ColorControl`,
`BlackAndWhiteControl`, `SharpenControl`, `CropControl`) is edited to render through
`Section`/`InstrumentSlider`/`Switch` instead of raw `<input>`/`<select>`/`<fieldset>` — no
change to any of their exported prop types.

### Other files

- `apps/web/components.json` (new, shadcn config), `apps/web/src/lib/utils.ts` (new, `cn`
  helper) — written by `shadcn init`.
- `apps/web/src/app/globals.css` — shadcn's generated `:root`/`.dark` token block, values
  replaced with the safelight palette above (oklch, converted from the hex table via a
  one-off sRGB→OKLCH script rather than guessed, per `CLAUDE.md` §0 "never invent... a
  browser capability" — color math included); `--radius` tightened from shadcn's default
  `0.625rem` to `0.375rem` for a crisper "instrument panel" feel over soft consumer
  rounding; `--font-sans`/`--font-heading` fixed to actually reference the already-loaded
  `--font-geist-sans` (the generator left `--font-sans: var(--font-sans)`, a circular
  no-op, uncaught until reviewed).
- `apps/web/src/app/layout.tsx` — force the `dark` class on `<html>` (this app has no
  light-mode toggle); fix the leftover scaffold `metadata` (`title: "Create Next App"` →
  `"Plexus"`, a real `description`).

## Porquê

Phase 2's editor is functionally done but visually still looks like the debug harness it
started as — for a project whose own spec sets "must feel like Apple Photos" as an explicit
bar, that gap is the most visible thing left before this is demoable as the standalone
milestone the spec's phasing calls it out to be ("Phase 2... a genuinely good single-image
editor is a legitimate, shippable thing on its own"). The user asked to move to UI/UX work
specifically because the presigned-upload backend task (`TASK-presigned-upload.md`) needs
Docker/MinIO, which isn't available right now — this task needs neither: it's pure
frontend, verifiable by running `pnpm dev` and looking at it, no infra dependency.

Scoping the new tokens to `.plx-editor` rather than global `:root`, and wrapping native
inputs rather than reimplementing drag/keyboard handling, both keep this a contained
presentational change: zero risk to the recipe/pipeline logic `CLAUDE.md` calls out as
things that must not break (non-destructive editing, recipe/pipeline unification), and zero
risk to `preview-demo` or the still-default `/` route, which are explicitly not part of this
pass.

## Ficheiros afectados

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/components.json` | new | shadcn config (`radix-nova` style, `neutral` base color) |
| `apps/web/src/lib/utils.ts` | new | shadcn's `cn()` helper |
| `apps/web/src/components/ui/button.tsx` | new | shadcn-generated |
| `apps/web/src/components/ui/slider.tsx` | new, then edited | shadcn-generated, then: single-thumb only, `bipolar` fill mode added |
| `apps/web/src/components/ui/switch.tsx` | new | shadcn-generated, unedited |
| `apps/web/src/components/ui/toggle.tsx` | new | shadcn-generated (backs `toggle-group`), unedited |
| `apps/web/src/components/ui/toggle-group.tsx` | new | shadcn-generated, unedited |
| `apps/web/src/components/ui/label.tsx` | new | shadcn-generated, unedited |
| `apps/web/src/components/ui/separator.tsx` | new | shadcn-generated, unedited (available for later use) |
| `apps/web/src/components/ui/input.tsx` | new | shadcn-generated, unedited |
| `apps/web/package.json` / `pnpm-lock.yaml` | edit | shadcn init/add deps: `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `lucide-react`, `shadcn` (CLI, dev-time) |
| `apps/web/src/app/globals.css` | edit | safelight oklch tokens in `:root`/`.dark`; `--radius` tightened; `--font-sans`/`--font-heading` fixed |
| `apps/web/src/app/layout.tsx` | edit | force `dark` class; fix leftover scaffold `metadata` |
| `apps/web/src/app/editor/page.tsx` | edit | restructure to top-bar/stage/rail layout; dropzone + drag-and-drop; `loadFile()` helper |
| `apps/web/src/components/editor/ui/Slider.tsx` | new | `InstrumentSlider` — label + `ui/slider` + readout |
| `apps/web/src/components/editor/ui/Section.tsx` | new | shared rail-section chrome |
| `apps/web/src/components/editor/LightControl.tsx` | edit | render via `Section`/`InstrumentSlider`; no prop change |
| `apps/web/src/components/editor/ColorControl.tsx` | edit | render via `Section`/`InstrumentSlider`; no prop change |
| `apps/web/src/components/editor/BlackAndWhiteControl.tsx` | edit | render via `Section`/`InstrumentSlider`/`Switch`; no prop change |
| `apps/web/src/components/editor/SharpenControl.tsx` | edit | render via `Section`/`InstrumentSlider`; no prop change |
| `apps/web/src/components/editor/CropControl.tsx` | edit | render via `Section`/`Switch`; restyle canvas frame + selection rect color; no prop change |
| `apps/web/src/components/PreviewCanvas.tsx` | edit | frame + mono status badge restyle via the same global tokens |
