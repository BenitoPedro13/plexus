import { z } from 'zod'

// Narrower than the orchestrator's BUILTIN_PROCESSORS
// (apps/orchestrator/src/pipelines/dto/create-pipeline.dto.ts): video/audio
// processors don't apply to the single-image editor.
export const imageProcessorId = z.enum([
  'image.resize',
  'image.convert',
  'image.compress',
  'image.crop',
  'image.adjustLight',
  'image.adjustColor',
  'image.blackAndWhite',
  'image.sharpen',
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

// Mirrors workers/internal/processors/crop.go's doc comment. Normalized (0.0..1.0)
// fractions of the source image's dimensions, not absolute pixels — see
// docs/tasks/TASK-image-crop.md "Porquê" for why: it's what makes the same crop step
// correct at both live-preview resolution and full-resolution export.
export const cropParamsSchema = z
  .object({
    x: z.number().min(0.0).max(1.0),
    y: z.number().min(0.0).max(1.0),
    width: z.number().gt(0.0).max(1.0),
    height: z.number().gt(0.0).max(1.0),
  })
  .refine((v) => v.x + v.width <= 1.0001, {
    message: 'x + width must not exceed 1.0',
    path: ['width'],
  })
  .refine((v) => v.y + v.height <= 1.0001, {
    message: 'y + height must not exceed 1.0',
    path: ['height'],
  })

export type CropParams = z.infer<typeof cropParamsSchema>

// P0 param subset from docs/tasks/TASK-composite-slider-mapping.md's mapping table,
// extended by docs/tasks/TASK-highlights-shadows-tonelut.md (resolved V-7).
// highlights/shadows are optional/defaulted (0.0 = no-op), unlike the other four,
// so pre-existing recipes authored before this task don't need updating.
// Deferred param (brilliance — no libvips primitive identified) intentionally
// omitted: no schema field without a backing Go processor.
export const adjustLightParamsSchema = z.object({
  exposure: z.number().min(-3.0).max(3.0),
  brightness: z.number().min(-1.0).max(1.0),
  contrast: z.number().min(-1.0).max(1.0),
  blackPoint: z.number().min(0.0).max(1.0),
  highlights: z.number().min(-1.0).max(1.0).default(0.0),
  shadows: z.number().min(-1.0).max(1.0).default(0.0),
})

export type AdjustLightParams = z.infer<typeof adjustLightParamsSchema>

// P0 param subset from docs/tasks/TASK-composite-slider-mapping.md's mapping table,
// extended by docs/tasks/TASK-adjust-color-cast.md (resolved D-27). castStrength is
// optional/defaulted (0.0 = no-op), like adjustLightParamsSchema's highlights/shadows,
// so pre-existing recipes authored before this task don't need updating. Deferred param
// (vibrance — curve is a visual judgment call, D-29) intentionally omitted, see
// docs/90-deferred-register.md.
export const adjustColorParamsSchema = z.object({
  saturation: z.number().min(-1.0).max(1.0),
  castStrength: z.number().min(0.0).max(1.0).default(0.0),
})

export type AdjustColorParams = z.infer<typeof adjustColorParamsSchema>

// P0 param subset from docs/tasks/TASK-composite-slider-mapping.md's mapping table,
// extended by docs/tasks/TASK-black-and-white-grain.md (resolved D-28). grain is
// optional/defaulted (0.0 = no-op), like adjustColorParamsSchema's castStrength, so
// pre-existing recipes authored before this task don't need updating.
export const blackAndWhiteParamsSchema = z.object({
  intensity: z.number().min(0.0).max(1.0),
  neutrals: z.number().min(-1.0).max(1.0),
  tone: z.number().min(-1.0).max(1.0),
  grain: z.number().min(0.0).max(1.0).default(0.0),
})

export type BlackAndWhiteParams = z.infer<typeof blackAndWhiteParamsSchema>

// P0 param subset from docs/tasks/TASK-composite-slider-mapping.md's mapping table.
// Deferred params (edges, falloff — no clean govips primitive found) intentionally
// omitted.
export const sharpenParamsSchema = z.object({
  intensity: z.number().min(0.0).max(1.0),
})

export type SharpenParams = z.infer<typeof sharpenParamsSchema>

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
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.crop'),
    params: cropParamsSchema,
  }),
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.adjustLight'),
    params: adjustLightParamsSchema,
  }),
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.adjustColor'),
    params: adjustColorParamsSchema,
  }),
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.blackAndWhite'),
    params: blackAndWhiteParamsSchema,
  }),
  z.object({
    id: z.string().min(1),
    processor: z.literal('image.sharpen'),
    params: sharpenParamsSchema,
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

// Bridges Zod's discriminated union to apps/orchestrator's class-validator
// DTOs, which can't compose with a Zod schema directly (TASK-recipe-packages-
// extraction.md) — a per-processor lookup table, so a custom class-validator
// decorator can validate `params` against the schema matching a sibling
// `processor` field without re-deriving the discriminated union's branches.
export const imageProcessorParamsSchemas = {
  'image.resize': resizeParamsSchema,
  'image.convert': convertParamsSchema,
  'image.compress': compressParamsSchema,
  'image.crop': cropParamsSchema,
  'image.adjustLight': adjustLightParamsSchema,
  'image.adjustColor': adjustColorParamsSchema,
  'image.blackAndWhite': blackAndWhiteParamsSchema,
  'image.sharpen': sharpenParamsSchema,
} as const satisfies Record<ImageProcessorId, z.ZodTypeAny>
