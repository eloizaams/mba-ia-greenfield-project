import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import { STORAGE_CLIENT } from './storage.constants';

// Inside the test container the browser-reachable endpoint is unreachable
// (localhost points to the container itself) — sign against the Compose
// service name so the test can exercise the presigned URLs it generates.
const TEST_ENV_OVERRIDES: Record<string, string> = {
  STORAGE_PUBLIC_ENDPOINT: 'http://storage:9000',
};

const buildModule = async (
  envOverrides: Record<string, string> = {},
): Promise<TestingModule> => {
  const previous: Record<string, string | undefined> = {};
  const overrides = { ...TEST_ENV_OVERRIDES, ...envOverrides };
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
          ignoreEnvFile: true,
        }),
        StorageModule,
      ],
    }).compile();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe('StorageService (integration — MinIO)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;
  let rawClient: S3Client;
  const keyPrefix = `integration-tests/${Date.now()}`;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await buildModule();
    service = moduleRef.get(StorageService);
    rawClient = moduleRef.get(STORAGE_CLIENT);
  });

  afterAll(async () => {
    const bucket = process.env.STORAGE_BUCKET || 'videos';
    for (const key of createdKeys) {
      await rawClient.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    }
    await moduleRef.close();
  });

  it('should complete the full multipart cycle and serve an intact object', async () => {
    const key = `${keyPrefix}/full-cycle.bin`;
    const body = 'streamtube-integration-payload';

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    expect(uploadId).toBeTruthy();

    const partUrl = await service.getSignedPartUrl(key, uploadId, 1);
    const putResponse = await fetch(partUrl, { method: 'PUT', body });
    expect(putResponse.status).toBe(200);

    const parts = await service.listParts(key, uploadId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partNumber).toBe(1);
    expect(parts[0].eTag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, parts);
    createdKeys.push(key);

    const getUrl = await service.getPresignedGetUrl(key);
    const getResponse = await fetch(getUrl);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.text()).resolves.toBe(body);
  });

  it('should stop listing parts after the multipart upload is aborted', async () => {
    const key = `${keyPrefix}/aborted.bin`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const partUrl = await service.getSignedPartUrl(key, uploadId, 1);
    await fetch(partUrl, { method: 'PUT', body: 'to-be-aborted' });

    await service.abortMultipartUpload(key, uploadId);

    await expect(service.listParts(key, uploadId)).rejects.toThrow();
  });

  it('should serve downloads with Content-Disposition attachment', async () => {
    const key = `${keyPrefix}/download.bin`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const partUrl = await service.getSignedPartUrl(key, uploadId, 1);
    await fetch(partUrl, { method: 'PUT', body: 'download-me' });
    const parts = await service.listParts(key, uploadId);
    await service.completeMultipartUpload(key, uploadId, parts);
    createdKeys.push(key);

    const downloadUrl = await service.getPresignedGetUrl(key, {
      downloadFilename: 'video.mp4',
    });
    const response = await fetch(downloadUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('video.mp4');
  });

  it('should reject presigned GET requests after expiry', async () => {
    const shortLivedModule = await buildModule({
      STORAGE_PRESIGNED_EXPIRY_SECONDS: '1',
    });
    const shortLivedService = shortLivedModule.get(StorageService);

    const key = createdKeys[0];
    const url = await shortLivedService.getPresignedGetUrl(key);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const response = await fetch(url);
    expect(response.status).toBe(403);

    await shortLivedModule.close();
  });

  it('should sign URLs against the browser-reachable public endpoint, not the internal host', async () => {
    const publicEndpoint = 'http://public.example.test:9000';
    const publicModule = await buildModule({
      STORAGE_PUBLIC_ENDPOINT: publicEndpoint,
    });
    const publicService = publicModule.get(StorageService);

    const key = `${keyPrefix}/endpoint-check.bin`;
    const uploadId = await publicService.createMultipartUpload(
      key,
      'video/mp4',
    );

    const partUrl = await publicService.getSignedPartUrl(key, uploadId, 1);
    const getUrl = await publicService.getPresignedGetUrl(key);
    expect(new URL(partUrl).host).toBe('public.example.test:9000');
    expect(new URL(getUrl).host).toBe('public.example.test:9000');

    await publicService.abortMultipartUpload(key, uploadId);
    await publicModule.close();
  });
});
