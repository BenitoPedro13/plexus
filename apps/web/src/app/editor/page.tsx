'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Images, Redo2, Undo2 } from 'lucide-react'
import { AppHeader, JobsLink } from '@/components/AppHeader'
import { BlackAndWhiteControl } from '@/components/editor/BlackAndWhiteControl'
import { ColorControl } from '@/components/editor/ColorControl'
import { CropControl } from '@/components/editor/CropControl'
import { LightControl } from '@/components/editor/LightControl'
import { SharpenControl } from '@/components/editor/SharpenControl'
import { Section } from '@/components/editor/ui/Section'
import { Dropzone } from '@/components/Dropzone'
import { PreviewCanvas } from '@/components/PreviewCanvas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { applyToBatch } from '@/lib/editor/batch'
import { useRecipeHistory } from '@/lib/editor/history'
import { exportRecipe, triggerDownload } from '@/lib/editor/export'
import { identityLightParams } from '@/lib/editor/light-blend'
import { takePendingFile } from '@/lib/pending-file'
import type { AdjustColorParams, AdjustLightParams, BlackAndWhiteParams, CropParams, Recipe } from '@/lib/recipe/schema'

interface EditState {
  width: number
  height: number
  fit: 'inside' | 'cover'
  cropEnabled: boolean
  crop: CropParams | null
  light: AdjustLightParams
  color: AdjustColorParams
  bwEnabled: boolean
  bw: BlackAndWhiteParams
  sharpenIntensity: number
}

const identityBwParams: BlackAndWhiteParams = { intensity: 0, neutrals: 0, tone: 0, grain: 0 }
const identityColorParams: AdjustColorParams = { saturation: 0, castStrength: 0 }

const initialEditState: EditState = {
  width: 400,
  height: 400,
  fit: 'inside',
  cropEnabled: false,
  crop: null,
  light: identityLightParams,
  color: identityColorParams,
  bwEnabled: false,
  bw: identityBwParams,
  sharpenIntensity: 0,
}

// Only emits a composite step when it differs from identity (B&W: when
// enabled at all) -- keeps hand-edited recipes minimal instead of a fixed
// five-step stack of mostly no-ops, per docs/tasks/TASK-editor-composite-ui.md.
// crop, when enabled and a rect has actually been drawn, is emitted
// *before* resize -- "select a region of the original, then thumbnail-fit
// that region" -- see docs/tasks/TASK-crop-preview-parity.md "Porquê" for
// why this recipe order is also what makes computeGeometryChain's
// order-sensitivity load-bearing. Disabling the tool (cropEnabled = false)
// stops emitting the step without discarding the drawn rect, same
// enabled/value split BlackAndWhiteControl already uses -- re-enabling
// shows the previous selection again rather than forcing a redraw.
function deriveRecipe(state: EditState): Recipe {
  const steps: Recipe['steps'] = []

  if (state.cropEnabled && state.crop) {
    steps.push({ id: 'crop', processor: 'image.crop', params: state.crop })
  }

  steps.push({
    id: 'resize',
    processor: 'image.resize',
    params: { width: state.width, height: state.height, fit: state.fit },
  })

  const { light } = state
  if (
    light.exposure !== 0 ||
    light.brightness !== 0 ||
    light.contrast !== 0 ||
    light.blackPoint !== 0 ||
    light.highlights !== 0 ||
    light.shadows !== 0
  ) {
    steps.push({ id: 'light', processor: 'image.adjustLight', params: light })
  }

  if (state.color.saturation !== 0 || state.color.castStrength !== 0) {
    steps.push({ id: 'color', processor: 'image.adjustColor', params: state.color })
  }

  if (state.bwEnabled) {
    steps.push({ id: 'bw', processor: 'image.blackAndWhite', params: state.bw })
  }

  if (state.sharpenIntensity !== 0) {
    steps.push({
      id: 'sharpen',
      processor: 'image.sharpen',
      params: { intensity: state.sharpenIntensity },
    })
  }

  return { steps }
}

// The real editor route -- curated Light/Color/B&W/Sharpen controls plus
// undo/redo, per the spec's P0 editor bullets. apps/web/src/app/preview-demo
// remains the renderer smoke-test harness (raw params, no history); this
// page is the primary surface. See docs/tasks/TASK-editor-composite-ui.md
// and, for the visual design pass, docs/tasks/TASK-editor-visual-design.md.
export default function EditorPage() {
  const router = useRouter()
  const [image, setImage] = useState<ImageBitmap | null>(null)
  // The original uploaded File, kept alongside the decoded ImageBitmap
  // used for live preview -- export needs the untouched original bytes
  // (workers/cmd/renderserver's processors read a real image file, not a
  // canvas re-encode), see docs/tasks/TASK-editor-export.md.
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [isSubmittingBatch, setIsSubmittingBatch] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const batchFileInputRef = useRef<HTMLInputElement>(null)
  const history = useRecipeHistory<EditState>(initialEditState)
  const live = history.present

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isModifier = event.metaKey || event.ctrlKey
      if (!isModifier || event.key.toLowerCase() !== 'z') return
      event.preventDefault()
      if (event.shiftKey) {
        history.redo()
      } else {
        history.undo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [history])

  async function loadFile(file: File) {
    const bitmap = await createImageBitmap(file)
    setImage(bitmap)
    setSourceFile(file)
    setExportError(null)
  }

  // Picks up a file the home page's drop-zone already captured
  // (apps/web/src/lib/pending-file.ts) so dropping a photo on `/` doesn't
  // force a second drop here. Absent (direct visit, hard refresh) is the
  // normal case and falls through to this page's own empty-state dropzone.
  // A one-shot read of an external module-level stash, not a
  // derivable-from-props value; takePendingFile() self-clears so this can't
  // loop or re-fire on a later render.
  useEffect(() => {
    const file = takePendingFile()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (file) void loadFile(file)
  }, [])

  const recipe = deriveRecipe(live)

  async function handleExport() {
    if (!sourceFile) return
    setIsExporting(true)
    setExportError(null)
    try {
      const blob = await exportRecipe(sourceFile, recipe)
      const baseName = sourceFile.name.replace(/\.[^./]+$/, '') || 'export'
      triggerDownload(blob, baseName)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExporting(false)
    }
  }

  // "Apply to Batch" -- the async-pipeline sibling of handleExport's
  // synchronous single-image path. Uploads every picked file, posts the
  // *current* recipe unmodified to POST /pipelines, then creates one job
  // per file (apps/web/src/lib/editor/batch.ts), and navigates to the
  // progress view. See docs/tasks/TASK-apply-to-batch.md.
  async function handleApplyToBatchFiles(files: File[]) {
    if (files.length === 0) return
    setIsSubmittingBatch(true)
    setBatchError(null)
    try {
      const pipelineName = `Apply to batch (${files.length} file${files.length === 1 ? '' : 's'}) -- ${new Date().toISOString()}`
      const { pipelineId, jobIds } = await applyToBatch(files, recipe, pipelineName)
      router.push(`/batch/${pipelineId}?jobs=${jobIds.join(',')}`)
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmittingBatch(false)
    }
  }

  async function handleBatchFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    await handleApplyToBatchFiles(files)
  }

  return (
    <div className="flex h-full min-h-screen flex-col bg-background text-foreground">
      <AppHeader
        crumbs={[{ label: 'Home', href: '/' }, { label: 'Editor' }]}
        right={
          <>
            <Button variant="ghost" size="icon-sm" onClick={history.undo} disabled={!history.canUndo} aria-label="Undo">
              <Undo2 />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={history.redo} disabled={!history.canRedo} aria-label="Redo">
              <Redo2 />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isSubmittingBatch}
              onClick={() => batchFileInputRef.current?.click()}
            >
              <Images />
              {isSubmittingBatch ? 'Applying…' : 'Apply to Batch'}
            </Button>
            <input
              ref={batchFileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={handleBatchFileChange}
            />
            <Button size="sm" onClick={handleExport} disabled={!sourceFile || isExporting}>
              {isExporting ? 'Exporting…' : 'Export'}
            </Button>
            <JobsLink />
          </>
        }
      />

      {exportError && (
        <p className="border-b border-border bg-destructive/10 px-4 py-2 font-mono text-[11px] text-destructive">
          {exportError}
        </p>
      )}
      {batchError && (
        <p className="border-b border-border bg-destructive/10 px-4 py-2 font-mono text-[11px] text-destructive">
          {batchError}
        </p>
      )}

      <div className="flex flex-1 items-stretch">
        <section className="flex flex-1 items-center justify-center overflow-auto p-8">
          {image ? (
            <PreviewCanvas image={image} recipe={recipe} />
          ) : (
            <Dropzone
              accept="image/*"
              label="Drop a photo, or click to choose"
              onFile={loadFile}
              className="h-full min-h-96 w-full max-w-2xl"
            />
          )}
        </section>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card px-4">
          <Section
            title="Resize"
            headerExtra={
              <ToggleGroup
                type="single"
                value={live.fit}
                spacing={0}
                onValueChange={(fit) => {
                  if (!fit) return
                  history.setPresent({ ...live, fit: fit as 'inside' | 'cover' })
                  history.commit()
                }}
              >
                <ToggleGroupItem value="inside" variant="outline" size="sm" className="font-mono text-[10px] uppercase">
                  Inside
                </ToggleGroupItem>
                <ToggleGroupItem value="cover" variant="outline" size="sm" className="font-mono text-[10px] uppercase">
                  Cover
                </ToggleGroupItem>
              </ToggleGroup>
            }
          >
            <div className="flex gap-3" onPointerUp={history.commit}>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="resize-width" className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
                  Width
                </Label>
                <Input
                  id="resize-width"
                  type="number"
                  min={1}
                  value={live.width}
                  className="font-mono tabular-nums"
                  onChange={(event) => history.setPresent({ ...live, width: Number(event.target.value) })}
                  onBlur={history.commit}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="resize-height" className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
                  Height
                </Label>
                <Input
                  id="resize-height"
                  type="number"
                  min={1}
                  value={live.height}
                  className="font-mono tabular-nums"
                  onChange={(event) => history.setPresent({ ...live, height: Number(event.target.value) })}
                  onBlur={history.commit}
                />
              </div>
            </div>
          </Section>

          <CropControl
            image={image}
            value={live.crop}
            enabled={live.cropEnabled}
            onEnabledChange={(cropEnabled) => {
              history.setPresent({ ...live, cropEnabled })
              history.commit()
            }}
            onChange={(crop) => history.setPresent({ ...live, crop })}
            onCommit={history.commit}
          />
          <LightControl
            value={live.light}
            onChange={(light) => history.setPresent({ ...live, light })}
            onCommit={history.commit}
          />
          <ColorControl
            value={live.color}
            onChange={(color) => history.setPresent({ ...live, color })}
            onCommit={history.commit}
          />
          <BlackAndWhiteControl
            enabled={live.bwEnabled}
            value={live.bw}
            onEnabledChange={(bwEnabled) => {
              history.setPresent({ ...live, bwEnabled })
            }}
            onChange={(bw) => history.setPresent({ ...live, bw })}
            onCommit={history.commit}
          />
          <SharpenControl
            intensity={live.sharpenIntensity}
            onChange={(sharpenIntensity) => history.setPresent({ ...live, sharpenIntensity })}
            onCommit={history.commit}
          />
        </aside>
      </div>
    </div>
  )
}
