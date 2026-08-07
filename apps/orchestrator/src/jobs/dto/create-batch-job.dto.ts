import { ArrayMinSize, IsString, IsUUID } from 'class-validator';

export class CreateBatchJobDto {
  @IsUUID()
  pipelineId!: string;

  // One object-storage key per file (POST /uploads/presign, see
  // src/upload/upload.controller.ts) — same opaque-string contract as
  // CreateJobDto.inputRef, just N of them. Each becomes its own `jobs` row
  // against the shared pipelineId; see JobsService.createBatch.
  @ArrayMinSize(1)
  @IsString({ each: true })
  inputRefs!: string[];
}
