import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-uploads', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let throttlerStorage: ThrottlerStorageService;

  const fakeStorage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getSignedPartUrl: jest.fn().mockResolvedValue('http://signed/part'),
    listParts: jest.fn().mockResolvedValue([]),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getPresignedGetUrl: jest.fn().mockResolvedValue('http://signed/get'),
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
    // Fecha a conexão da fila explicitamente — sem isso o ioredis do BullMQ
    // segura o event loop e o Jest não encerra.
    const queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    fakeStorage.createMultipartUpload.mockReset();
    fakeStorage.createMultipartUpload.mockResolvedValue('e2e-upload-1');
  });

  async function createAuthenticatedUser(): Promise<{
    token: string;
    userId: string;
  }> {
    const email = `uploader-${Date.now()}@test.local`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const token = await jwtService.signAsync({ sub: user.id, email });
    return { token, userId: user.id };
  }

  // ### 1. POST /videos/uploads

  it('initiate-upload-happy-path', async () => {
    const { token } = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'video.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect((response.body as Record<string, string>).videoId).toHaveLength(11);
    expect((response.body as Record<string, string>).uploadId).toBe(
      'e2e-upload-1',
    );
    expect((response.body as Record<string, string>).storageKey).toBeTruthy();

    const row = await dataSource.getRepository(Video).findOneOrFail({
      where: { publicId: (response.body as { videoId: string }).videoId },
      relations: { channel: true },
    });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.title).toBeNull();
    expect(row.description).toBeNull();
    expect(row.category).toBeNull();
    expect(row.uploadId).toBe('e2e-upload-1');
  });

  it('initiate-upload-sem-token', async () => {
    await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/videos/uploads')
      .send({ filename: 'video.mp4', contentType: 'video/mp4' })
      .expect(401);

    expect(await dataSource.getRepository(Video).count()).toBe(0);
  });

  it('initiate-upload-body-invalido', async () => {
    const { token } = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ contentType: 'video/mp4' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'video.mp4' })
      .expect(400);

    expect(await dataSource.getRepository(Video).count()).toBe(0);
  });

  it('initiate-upload-falha-storage', async () => {
    const { token } = await createAuthenticatedUser();
    fakeStorage.createMultipartUpload.mockRejectedValue(
      new Error('minio down'),
    );

    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'video.mp4', contentType: 'video/mp4' })
      .expect(502);

    expect(response.body as Record<string, unknown>).toEqual({
      statusCode: 502,
      error: 'STORAGE_PROVISIONING_ERROR',
      message: expect.any(String) as unknown,
    });
    expect(await dataSource.getRepository(Video).count()).toBe(0);
  });
});
