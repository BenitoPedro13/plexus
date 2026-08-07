import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

// Mirrors workers/cmd/renderserver/main.go's maxUploadBytes — same
// documented first-pass 64 MiB default, kept in sync by hand across the
// language boundary (same accepted duplication as D-8/D-17 in
// docs/90-deferred-register.md).
const MAX_EXPORT_UPLOAD_BYTES = 64 * 1024 * 1024;

// ExportController is a thin synchronous proxy in front of the Go render
// server (workers/cmd/renderserver) — the Phase 2 "editor export" path
// (spec P0: "export produces the same recipe format Plexus pipelines
// consume"). Deliberately bypasses PipelinesModule/JobsModule: those are
// the DB-backed, NATS-dispatched async machinery for Phase 3's "Apply to
// Batch," architecturally overkill for "render the one image I'm looking
// at right now." See docs/tasks/TASK-editor-export.md "Porquê".
@Controller('export')
export class ExportController {
  private readonly renderServerUrl: string;

  constructor() {
    this.renderServerUrl =
      process.env.RENDER_SERVER_URL ?? 'http://localhost:8090';
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_EXPORT_UPLOAD_BYTES } }),
  )
  async export(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('recipe') recipe: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException('missing "file" upload');
    }

    const form = new FormData();
    form.append(
      'file',
      // file.buffer types as Node's Buffer (ArrayBufferLike-backed), one
      // step looser than BlobPart's ArrayBuffer-backed ArrayBufferView —
      // a real Buffer works fine as a BlobPart at runtime (undici's Blob
      // accepts it), this is purely a lib.dom.d.ts/Node type mismatch.
      new Blob([file.buffer as unknown as BlobPart], {
        type: file.mimetype || 'application/octet-stream',
      }),
      file.originalname || 'source',
    );
    if (recipe !== undefined) {
      form.append('recipe', recipe);
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.renderServerUrl}/render`, {
        method: 'POST',
        body: form,
      });
    } catch (err) {
      throw new BadGatewayException(
        `render server unreachable: ${(err as Error).message}`,
      );
    }

    const body = Buffer.from(await upstream.arrayBuffer());

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) {
      res.setHeader('Content-Disposition', disposition);
    }
    res.send(body);
  }
}
