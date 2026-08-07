import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client as MinioClient } from 'minio';

// Presigned URL expiry — short-lived by design (spec P0: "no proxying large
// files through the API," but the signed URL itself still shouldn't be
// usable indefinitely). 15 minutes, matching TASK-presigned-upload.md §5.
const PRESIGN_EXPIRY_SECONDS = 15 * 60;

export interface PresignUploadResult {
  objectKey: string;
  uploadUrl: string;
}

export interface PresignDownloadResult {
  downloadUrl: string;
}

// Splits MINIO_ENDPOINT ("host:port", e.g. "localhost:9000" — see
// .env.example) into the host/port shape the minio npm client's
// ClientOptions wants, distinct from minio-go's single combined-string
// endpoint on the Go side.
function parseEndpoint(endpoint: string): { endPoint: string; port?: number } {
  const [host, port] = endpoint.split(':');
  return { endPoint: host, port: port ? Number(port) : undefined };
}

// sanitize strips characters that aren't safe as an S3 object key segment,
// so a user-supplied filename can't smuggle path traversal or otherwise
// odd characters into the key.
function sanitize(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, '-');
}

// UploadService wraps the official `minio` npm client (not
// @aws-sdk/client-s3 — see docs/tasks/TASK-presigned-upload.md's Porquê:
// live research found documented SignatureDoesNotMatch failures running the
// AWS SDK v3 presigner against MinIO). Presigned URLs let the client
// upload/download directly against MinIO — this service and its controller
// never proxy file bytes, per the spec's P0 line.
@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);
  private readonly client: MinioClient;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT ?? 'localhost:9000';
    const { endPoint, port } = parseEndpoint(endpoint);
    this.bucket = process.env.MINIO_BUCKET ?? 'plexus';

    this.client = new MinioClient({
      endPoint,
      port,
      accessKey: process.env.MINIO_ACCESS_KEY ?? '',
      secretKey: process.env.MINIO_SECRET_KEY ?? '',
      useSSL: process.env.MINIO_USE_SSL === 'true',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  // Idempotent create-if-missing, same behaviour as output.go's
  // os.MkdirAll and the Go storage.New()'s own bucket check.
  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      this.logger.log(`Created bucket "${this.bucket}"`);
    }
  }

  // The DTO also requires a contentType (see presign-upload.dto.ts) even
  // though it isn't consumed here — a plain S3 presigned PUT signature
  // doesn't bind headers unless additional signed headers are explicitly
  // requested, which neither minio-go nor the minio npm client's
  // presignedPutObject expose. Requiring it up front documents the client
  // contract (what Content-Type to send on the actual PUT) without pretending
  // the server enforces it.
  async presignUpload(filename: string): Promise<PresignUploadResult> {
    const objectKey = `uploads/${randomUUID()}-${sanitize(filename)}`;
    const uploadUrl = await this.client.presignedPutObject(
      this.bucket,
      objectKey,
      PRESIGN_EXPIRY_SECONDS,
    );
    return { objectKey, uploadUrl };
  }

  async presignDownload(objectKey: string): Promise<PresignDownloadResult> {
    const downloadUrl = await this.client.presignedGetObject(
      this.bucket,
      objectKey,
      PRESIGN_EXPIRY_SECONDS,
    );
    return { downloadUrl };
  }
}
