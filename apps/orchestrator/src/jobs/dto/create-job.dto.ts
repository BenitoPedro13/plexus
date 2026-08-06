import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateJobDto {
  @IsUUID()
  pipelineId!: string;

  // Opaque input location for Phase 1 — see D-3 in the deferred register.
  @IsString()
  @IsNotEmpty()
  inputRef!: string;
}
