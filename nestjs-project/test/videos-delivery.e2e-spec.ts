import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { User } from '../src/users/entities/user.entity';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-delivery', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let throttlerStorage: ThrottlerStorageService;

  const fakeStorage = {
    createMultipartUpload: jest.fn().mockResolvedValue('e2e-upload-1'),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getSignedPartUrl: jest.fn().mockResolvedValue('http://storage/signed'),
    listParts: jest.fn().mockResolvedValue([]),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getPresignedGetUrl: jest.fn(
      (key: string, options?: { downloadFilename?: string }) =>
        Promise.resolve(
          options?.downloadFilename
            ? `http://storage/${key}?response-content-disposition=attachment`
            : `http://storage/${key}?X-Amz-Signature=abc`,
        ),
    ),
  };

  beforeAll(async () => {
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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    const queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function createAuthenticatedUser(
    label: string,
  ): Promise<{ token: string; userId: string; channelId: string }> {
    const email = `${label}-${Date.now()}@test.local`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    const token = await jwtService.signAsync({ sub: user.id, email });
    return { token, userId: user.id, channelId: channel.id };
  }

  async function createVideo(
    channelId: string,
    status: VideoStatus,
  ): Promise<Video> {
    return dataSource.getRepository(Video).save({
      publicId: randomUUID().replace(/-/g, '').slice(0, 11),
      channelId,
      storageKey: `videos/e2e/${randomUUID()}.mp4`,
      status,
    });
  }

  // ### 1. GET /videos/:publicId/stream

  it('stream-happy-path', async () => {
    const { token, channelId } = await createAuthenticatedUser('owner');
    const video = await createVideo(channelId, VideoStatus.READY);

    const response = await request(app.getHttpServer())
      .get(`/videos/${video.publicId}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect((response.body as Record<string, string>).url).toBeTruthy();
    expect((response.body as Record<string, string>).url).not.toContain(
      'response-content-disposition',
    );
  });

  // ### 2. GET /videos/:publicId/download

  it('download-happy-path', async () => {
    const { token, channelId } = await createAuthenticatedUser('owner');
    const video = await createVideo(channelId, VideoStatus.READY);

    const response = await request(app.getHttpServer())
      .get(`/videos/${video.publicId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect((response.body as Record<string, string>).url).toContain(
      'response-content-disposition=attachment',
    );
  });

  // ### 3. Estados de erro compartilhados

  it('video-nao-pronto', async () => {
    const { token, channelId } = await createAuthenticatedUser('owner');
    const video = await createVideo(channelId, VideoStatus.PROCESSING);

    const streamResponse = await request(app.getHttpServer())
      .get(`/videos/${video.publicId}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect((streamResponse.body as Record<string, string>).error).toBe(
      'VIDEO_NOT_READY',
    );

    const downloadResponse = await request(app.getHttpServer())
      .get(`/videos/${video.publicId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect((downloadResponse.body as Record<string, string>).error).toBe(
      'VIDEO_NOT_READY',
    );
  });

  it('video-inexistente', async () => {
    const { token } = await createAuthenticatedUser('owner');

    const streamResponse = await request(app.getHttpServer())
      .get('/videos/nao-existe00/stream')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect((streamResponse.body as Record<string, string>).error).toBe(
      'VIDEO_NOT_FOUND',
    );

    const downloadResponse = await request(app.getHttpServer())
      .get('/videos/nao-existe00/download')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect((downloadResponse.body as Record<string, string>).error).toBe(
      'VIDEO_NOT_FOUND',
    );
  });

  it('sem-token', async () => {
    const { channelId } = await createAuthenticatedUser('owner');
    const video = await createVideo(channelId, VideoStatus.READY);

    await request(app.getHttpServer())
      .get(`/videos/${video.publicId}/stream`)
      .expect(401);

    await request(app.getHttpServer())
      .get(`/videos/${video.publicId}/download`)
      .expect(401);
  });
});
