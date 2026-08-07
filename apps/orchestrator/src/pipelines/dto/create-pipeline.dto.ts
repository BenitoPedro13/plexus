import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import {
  imageProcessorId,
  imageProcessorParamsSchemas,
  type ImageProcessorId,
} from '@plexus/recipe';

// Phase 1 built-in processors only (spec "Suggested Phasing" — Phase 1). External
// gRPC plugins are Phase 4; not accepted here. The 8 image.* ids are the single
// source of truth from @plexus/recipe (TASK-recipe-packages-extraction.md) — this
// list used to hand-maintain its own, staler copy that was missing crop/adjustLight/
// adjustColor/blackAndWhite/sharpen entirely. video.*/audio.* have no editor
// equivalent (they don't apply to a single-image recipe) and no TS param schema
// anywhere yet — only the Go processors under workers/internal/processors define
// their shape — so they stay hand-listed here and their params fall back to a
// plain-object check in ValidateProcessorParams below, not per-field validation.
export const BUILTIN_PROCESSORS = [
  ...imageProcessorId.options,
  'video.transcode',
  'video.compress',
  'audio.extract',
  'audio.convert',
] as const;

export type BuiltinProcessor = (typeof BUILTIN_PROCESSORS)[number];

const IMAGE_PROCESSOR_IDS = new Set<string>(imageProcessorId.options);

function isImageProcessor(processor: string): processor is ImageProcessorId {
  return IMAGE_PROCESSOR_IDS.has(processor);
}

// Bridges @plexus/recipe's Zod schemas into class-validator, which can't compose
// with Zod directly (no off-the-shelf adapter that fit both class-validator's
// per-property decorator model and Zod's discriminated union — see
// docs/tasks/TASK-recipe-packages-extraction.md "Mudanças planeadas"). Reads the
// sibling `processor` field via ValidationArguments.object to pick the matching
// schema; falls back to a plain-object check for video/audio, which have no schema.
function ValidateProcessorParams(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'validateProcessorParams',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const processor = (args.object as StepDto).processor;
          if (!isImageProcessor(processor)) {
            return typeof value === 'object' && value !== null;
          }
          return imageProcessorParamsSchemas[processor].safeParse(value)
            .success;
        },
        defaultMessage(args: ValidationArguments) {
          const processor = (args.object as StepDto).processor;
          if (!isImageProcessor(processor)) {
            return `params for "${processor}" must be an object`;
          }
          const result = imageProcessorParamsSchemas[processor].safeParse(
            args.value,
          );
          if (result.success) {
            return `params invalid for "${processor}"`;
          }
          const issues = result.error.issues
            .map(
              (issue) =>
                `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            )
            .join('; ');
          return `params invalid for "${processor}": ${issues}`;
        },
      },
    });
  };
}

export class StepDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsIn(BUILTIN_PROCESSORS)
  processor!: BuiltinProcessor;

  @IsObject()
  @ValidateProcessorParams()
  params!: Record<string, unknown>;

  // Phase 1 pipelines are linear: at most one dependency per step, enforced by
  // resolveLinearOrder(), not by this DTO's shape alone.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependsOn?: string[];
}

export class CreatePipelineDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => StepDto)
  steps!: StepDto[];
}
