import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { UploadService } from '../../src/upload/upload.service';

export interface TestStore {
  uploadService: UploadService;
  teardown: () => Promise<void>;
}

// Real MinIO via testcontainers, matching infra/docker-compose.yml's image
// — no mocking object storage, per CLAUDE.md's Tests section and
// docs/tasks/TASK-presigned-upload.md §6.
export async function setupTestStore(): Promise<TestStore> {
  const container: StartedMinioContainer = await new MinioContainer(
    'minio/minio:RELEASE.2025-09-07T16-13-09Z',
  ).start();

  process.env.MINIO_ENDPOINT = `${container.getHost()}:${container.getPort()}`;
  process.env.MINIO_ACCESS_KEY = container.getUsername();
  process.env.MINIO_SECRET_KEY = container.getPassword();
  process.env.MINIO_BUCKET = 'plexus-test';
  process.env.MINIO_USE_SSL = 'false';

  const uploadService = new UploadService();
  await uploadService.onModuleInit();

  return {
    uploadService,
    teardown: async () => {
      await container.stop();
    },
  };
}
