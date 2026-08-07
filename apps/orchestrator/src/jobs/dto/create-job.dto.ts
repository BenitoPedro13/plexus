import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateJobDto {
  @IsUUID()
  pipelineId!: string;

  // Object-storage key obtained from POST /uploads/presign
  // (src/upload/upload.controller.ts) — resolved D-3, see
  // docs/tasks/TASK-presigned-upload.md. Still an opaque string here: the
  // orchestrator threads it through Postgres/NATS without interpreting it,
  // same as before this was a real key rather than a raw filesystem path.
  @IsString()
  @IsNotEmpty()
  inputRef!: string;
}
