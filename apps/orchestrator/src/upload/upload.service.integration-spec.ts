import {
  setupTestStore,
  type TestStore,
} from '../../test/support/minio-test-store';

describe('UploadService (integration, real MinIO)', () => {
  let testStore: TestStore;

  beforeAll(async () => {
    testStore = await setupTestStore();
  }, 120_000);

  afterAll(async () => {
    await testStore.teardown();
  });

  it('presigns a PUT and a GET that round-trip real bytes through MinIO', async () => {
    const { uploadService } = testStore;
    const bytes = Buffer.from('plexus presign round-trip fixture bytes');

    const { objectKey, uploadUrl } =
      await uploadService.presignUpload('photo.jpg');
    expect(objectKey).toMatch(/^uploads\/.+-photo\.jpg$/);

    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: bytes,
    });
    expect(putRes.ok).toBe(true);

    const { downloadUrl } = await uploadService.presignDownload(objectKey);
    const getRes = await fetch(downloadUrl);
    expect(getRes.ok).toBe(true);
    const downloaded = Buffer.from(await getRes.arrayBuffer());

    expect(Buffer.compare(downloaded, bytes)).toBe(0);
  });

  it('sanitizes an unsafe filename into the object key', async () => {
    const { uploadService } = testStore;

    const { objectKey } = await uploadService.presignUpload(
      '../../etc/passwd?weird name.png',
    );

    expect(objectKey.startsWith('uploads/')).toBe(true);
    expect(objectKey).not.toContain('/../');
    expect(objectKey).not.toContain('?');
    expect(objectKey).not.toContain(' ');
  });

  it('presigning a download for a nonexistent key still returns a URL (existence is only checked on GET)', async () => {
    const { uploadService } = testStore;

    const { downloadUrl } = await uploadService.presignDownload(
      'uploads/does-not-exist.jpg',
    );
    const res = await fetch(downloadUrl);

    expect(res.status).toBe(404);
  });
});
