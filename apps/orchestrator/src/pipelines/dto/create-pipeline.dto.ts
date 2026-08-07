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
  builtinProcessorId,
  builtinProcessorParamsSchemas,
  type BuiltinProcessorId,
} from '@plexus/recipe';

// Phase 1 built-in processors only (spec "Suggested Phasing" — Phase 1). External
// gRPC plugins are Phase 4; not accepted here. All 12 ids (8 image.* + 2 video.* +
// 2 audio.*) are the single source of truth from @plexus/recipe
// (TASK-recipe-packages-extraction.md, extended by TASK-quick-actions-screen.md) —
// this list used to hand-maintain its own copy for video/audio with no per-field
// param schema, falling back to a plain-object check. Now every processor's params
// validate against its real schema via builtinProcessorParamsSchemas below.
export const BUILTIN_PROCESSORS = builtinProcessorId.options;

export type BuiltinProcessor = BuiltinProcessorId;

// Bridges @plexus/recipe's Zod schemas into class-validator, which can't compose
// with Zod directly (no off-the-shelf adapter that fit both class-validator's
// per-property decorator model and Zod's discriminated union — see
// docs/tasks/TASK-recipe-packages-extraction.md "Mudanças planeadas"). Reads the
// sibling `processor` field via ValidationArguments.object to pick the matching
// schema.
function ValidateProcessorParams(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'validateProcessorParams',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        // `processor` can be any string at this point -- @IsIn(BUILTIN_PROCESSORS)
        // runs as a sibling decorator, not a precondition, so an unknown id
        // must fail here too rather than throwing on the missing schema lookup.
        validate(value: unknown, args: ValidationArguments) {
          const processor = (args.object as StepDto).processor;
          const schema = builtinProcessorParamsSchemas[processor];
          return schema !== undefined && schema.safeParse(value).success;
        },
        defaultMessage(args: ValidationArguments) {
          const processor = (args.object as StepDto).processor;
          const schema = builtinProcessorParamsSchemas[processor];
          if (schema === undefined) {
            return `unknown processor "${processor}"`;
          }
          const result = schema.safeParse(args.value);
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

  // Absent entirely => implicitly depends on the previous array entry (root
  // if first). Present (including []) => authoritative, opts into a real
  // DAG. At most one dependency per step (fan-in unsupported). All enforced
  // by resolveDag(), not by this DTO's shape alone — see dag.validator.ts.
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
