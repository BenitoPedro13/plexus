import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  setupTestStore,
  type TestStore,
} from '../../test/support/minio-test-store';
import { UploadModule } from './upload.module';
import type {
  PresignDownloadResult,
  PresignUploadResult,
} from './upload.service';

describe('UploadController (integration, real MinIO)', () => {
  let testStore: TestStore;
  let app: INestApplication<App>;

  beforeAll(async () => {
    testStore = await setupTestStore();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [UploadModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testStore.teardown();
  });

  it('POST /uploads/presign returns an objectKey and a usable uploadUrl', async () => {
    const res = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ filename: 'gradient.jpg', contentType: 'image/jpeg' });

    const body = res.body as PresignUploadResult;

    expect(res.status).toBe(201);
    expect(typeof body.objectKey).toBe('string');
    expect(body.objectKey).toContain('gradient.jpg');
    expect(typeof body.uploadUrl).toBe('string');

    const putRes = await fetch(body.uploadUrl, {
      method: 'PUT',
      body: Buffer.from('fixture-bytes'),
    });
    expect(putRes.ok).toBe(true);
  });

  it('POST /uploads/presign rejects a missing filename', async () => {
    const res = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
  });

  it('GET /uploads/presign-download returns a downloadUrl that fetches uploaded bytes', async () => {
    const presignRes = await request(app.getHttpServer())
      .post('/uploads/presign')
      .send({ filename: 'roundtrip.txt', contentType: 'text/plain' });
    const presignBody = presignRes.body as PresignUploadResult;
    const objectKey = presignBody.objectKey;

    const bytes = Buffer.from('controller round-trip fixture');
    await fetch(presignBody.uploadUrl, {
      method: 'PUT',
      body: bytes,
    });

    const downloadRes = await request(app.getHttpServer())
      .get('/uploads/presign-download')
      .query({ key: objectKey });
    const downloadBody = downloadRes.body as PresignDownloadResult;

    expect(downloadRes.status).toBe(200);
    const getRes = await fetch(downloadBody.downloadUrl);
    const downloaded = Buffer.from(await getRes.arrayBuffer());
    expect(Buffer.compare(downloaded, bytes)).toBe(0);
  });

  it('GET /uploads/presign-download without a key returns 400', async () => {
    const res = await request(app.getHttpServer()).get(
      '/uploads/presign-download',
    );

    expect(res.status).toBe(400);
  });
});
