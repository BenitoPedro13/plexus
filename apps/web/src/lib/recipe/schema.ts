import { z } from 'zod'

// Narrower than the orchestrator's BUILTIN_PROCESSORS
// (apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts): video/audio
// processors don't apply to the single-image editor.
export const imageProcessorId = z.enum([
  'image.resize',
  'image.convert',
  'image.compress',
])

export type ImageProcessorId = z.infer<typeof imageProcessorId>

// Mirrors workers/internal/processors/resize.go's doc comment.
export const resizeParamsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fit: z.enum(['inside', 'cover']).default('inside'),
})

export type ResizeParams = z.infer<typeof resizeParamsSchema>

// Mirrors workers/internal/processors/convert.go's doc comment. `quality`'s
// default of 85 matches workers/internal/processors/format.go's
// defaultQuality constant.
export const convertParamsSchema = z.object({
  format: z.enum(['jpeg', 'png', 'webp', 'avif']),
  quality: z.number().int().min(1).max(100).default(85),
})

export type ConvertParams = z.infer<typeof convertParamsSchema>

// Mirrors workers/internal/processors/compress.go's doc comment. No format
// field: compress re-exports the input's original format, it never changes
// it — that's convert's job.
export const compressParamsSchema = z.object({
  quality: z.number().int().min(1).max(100),
})

export type CompressParams = z.infer<typeof compressParamsSchema>

export const recipeStepSchema = z.discriminatedUnion('processor', [
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.resize'),
    params: resizeParamsSchema,
  }),
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.convert'),
    params: convertParamsSchema,
  }),
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.compress'),
    params: compressParamsSchema,
  }),
])

export type RecipeStep = z.infer<typeof recipeStepSchema>

// Structurally identical to apps/orchestrator's PipelineStepDefinition[]
// (apps/orchestrator/src/db/schema.ts) minus `dependsOn`: a recipe is always
// a single linear chain expressed by array order, so there's no branching
// field to carry. No batch/orchestrator wiring yet (Phase 3, "Apply to
// Batch") — see docs/tasks/TASK-recipe-schema.md.
export const recipeSchema = z.object({
  name: z.string().min(1).optional(),
  // Empty is valid: an unedited image has a recipe with zero steps.
  steps: z.array(recipeStepSchema),
})

export type Recipe = z.infer<typeof recipeSchema>
