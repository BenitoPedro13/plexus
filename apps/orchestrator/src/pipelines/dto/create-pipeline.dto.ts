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
} from 'class-validator';

// Phase 1 built-in processors only (spec "Suggested Phasing" — Phase 1). External
// gRPC plugins are Phase 4; not accepted here.
export const BUILTIN_PROCESSORS = [
  'image.resize',
  'image.convert',
  'image.compress',
  'video.transcode',
  'video.compress',
  'audio.extract',
  'audio.convert',
] as const;

export type BuiltinProcessor = (typeof BUILTIN_PROCESSORS)[number];

export class StepDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsIn(BUILTIN_PROCESSORS)
  processor!: BuiltinProcessor;

  @IsObject()
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
