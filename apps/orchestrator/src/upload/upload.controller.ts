import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { PresignUploadDto } from './dto/presign-upload.dto';
import {
  UploadService,
  type PresignDownloadResult,
  type PresignUploadResult,
} from './upload.service';

// UploadController hands out presigned MinIO URLs — clients upload/download
// directly against object storage with the returned URL, so the orchestrator
// never proxies file bytes (spec P0: "no proxying large files through the
// API"). Generic (not job-specific): covers both a fresh upload ahead of
// POST /jobs and, later, fetching any stored object (e.g. a step's
// outputRef) — see docs/tasks/TASK-presigned-upload.md §5.
@Controller('uploads')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('presign')
  presignUpload(@Body() dto: PresignUploadDto): Promise<PresignUploadResult> {
    return this.uploadService.presignUpload(dto.filename);
  }

  @Get('presign-download')
  presignDownload(@Query('key') key?: string): Promise<PresignDownloadResult> {
    if (!key) {
      throw new BadRequestException('missing "key" query parameter');
    }
    return this.uploadService.presignDownload(key);
  }
}
