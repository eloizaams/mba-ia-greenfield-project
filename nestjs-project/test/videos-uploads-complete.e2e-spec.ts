import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_REQUESTED_JOB,
} from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-uploads-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;

  const fakeStorage = {
    createMultipartUpload: jest.fn().mockResolvedValue('e2e-upload-1'),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getSignedPartUrl: jest.fn().mockResolvedValue('http://storage/signed'),
    listParts: jest.fn().mockResolvedValue([]),
    completeMultipartUpload: jest.fn(),
    getPresignedGetUrl: jest.fn().mockResolvedValue('http://signed/get'),
  };

  beforeAll(async () => {
    // Prefixo próprio: sem ele o video-worker de desenvolvimento (mesma
    // instância Redis) consome os jobs publicados pelo teste.
    process.env.QUEUE_PREFIX = `test-e2e-${Date.now()}`;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue(fakeStorage)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    jwtService = moduleFixture.get(JwtService, { strict: false });
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await app.close();
    delete process.env.QUEUE_PREFIX;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    fakeStorage.completeMultipartUpload.mockReset();
    fakeStorage.completeMultipartUpload.mockResolvedValue(undefined);
    fakeStorage.abortMultipartUpload.mockClear();
    await queue.drain(true);
  });

  async function createAuthenticatedUser(
    label: string,
  ): Promise<{ token: string }> {
    const email = `${label}-${Date.now()}@test.local`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const token = await jwtService.signAsync({ sub: user.id, email });
    return { token };
  }

  async function createUpload(token: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'complete.mp4', contentType: 'video/mp4' })
      .expect(201);
    return (response.body as { videoId: string }).videoId;
  }

  const parts = [{ partNumber: 1, eTag: 'etag-1' }];

  // ### 1. POST /videos/uploads/:videoId/complete

  it('complete-happy-path', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);

    const response = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(200);

    expect(response.body).toEqual({ videoId, status: 'processing' });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ publicId: videoId });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.uploadId).toBeNull();

    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe(VIDEO_PROCESSING_REQUESTED_JOB);
    expect(waiting[0].data).toEqual({
      videoId: row.id,
      storageKey: row.storageKey,
    });
  });

  it('complete-falha-storage', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);
    fakeStorage.completeMultipartUpload.mockRejectedValue(
      new Error('minio down'),
    );

    const response = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(502);
    expect((response.body as Record<string, string>).error).toBe(
      'STORAGE_PROVISIONING_ERROR',
    );

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ publicId: videoId });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(await queue.getWaiting()).toHaveLength(0);
  });

  // ### 2. DELETE /videos/uploads/:videoId

  it('abort-happy-path', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);

    const response = await request(app.getHttpServer())
      .delete(`/videos/uploads/${videoId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(response.body).toEqual({});
    expect(fakeStorage.abortMultipartUpload).toHaveBeenCalledTimes(1);

    await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  // ### 3. Estados de erro compartilhados

  it('complete-ou-abort-de-upload-ja-finalizado', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);
    await dataSource
      .getRepository(Video)
      .update(
        { publicId: videoId },
        { status: VideoStatus.PROCESSING, uploadId: null },
      );

    const completeResponse = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(409);
    expect((completeResponse.body as Record<string, string>).error).toBe(
      'UPLOAD_ALREADY_COMPLETED',
    );

    const abortResponse = await request(app.getHttpServer())
      .delete(`/videos/uploads/${videoId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect((abortResponse.body as Record<string, string>).error).toBe(
      'UPLOAD_ALREADY_COMPLETED',
    );
  });

  it('upload-inexistente-ou-de-outro-dono', async () => {
    const { token: ownerToken } = await createAuthenticatedUser('owner');
    const { token: intruderToken } = await createAuthenticatedUser('intruder');
    const videoId = await createUpload(ownerToken);

    const missing = await request(app.getHttpServer())
      .post('/videos/uploads/nao-existe00/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts })
      .expect(404);
    expect((missing.body as Record<string, string>).error).toBe(
      'UPLOAD_NOT_FOUND',
    );

    const intruded = await request(app.getHttpServer())
      .delete(`/videos/uploads/${videoId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);
    expect((intruded.body as Record<string, string>).error).toBe(
      'UPLOAD_NOT_FOUND',
    );
    // sem distinção entre inexistente e outro dono
    expect(intruded.body).toEqual(missing.body);
  });
});
