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
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-uploads-parts', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let throttlerStorage: ThrottlerStorageService;

  const fakeStorage = {
    createMultipartUpload: jest.fn().mockResolvedValue('e2e-upload-1'),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getSignedPartUrl: jest.fn().mockResolvedValue('http://storage/signed-part'),
    listParts: jest.fn().mockResolvedValue([{ partNumber: 1, eTag: 'etag-1' }]),
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
  ): Promise<{ token: string; userId: string }> {
    const email = `${label}-${Date.now()}@test.local`;
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

  async function createUpload(token: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'parts.mp4', contentType: 'video/mp4' })
      .expect(201);
    return (response.body as { videoId: string }).videoId;
  }

  async function markCompleted(videoId: string): Promise<void> {
    await dataSource
      .getRepository(Video)
      .update(
        { publicId: videoId },
        { status: VideoStatus.PROCESSING, uploadId: null },
      );
  }

  // ### 1. POST /videos/uploads/:videoId/parts

  it('sign-part-happy-path', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);

    const response = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumber: 1 })
      .expect(200);

    expect(response.body).toEqual({ url: 'http://storage/signed-part' });
  });

  it('sign-part-part-number-invalido', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);

    await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumber: 'abc' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
  });

  // ### 2. GET /videos/uploads/:videoId/parts

  it('list-parts-happy-path', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);

    const response = await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      parts: [{ partNumber: 1, eTag: 'etag-1' }],
    });
  });

  // ### 3. Estados de erro compartilhados

  it('upload-inexistente-ou-de-outro-dono', async () => {
    const { token: ownerToken } = await createAuthenticatedUser('owner');
    const { token: intruderToken } = await createAuthenticatedUser('intruder');
    const videoId = await createUpload(ownerToken);

    const missing = await request(app.getHttpServer())
      .post('/videos/uploads/nao-existe00/parts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ partNumber: 1 })
      .expect(404);
    expect((missing.body as Record<string, string>).error).toBe(
      'UPLOAD_NOT_FOUND',
    );

    const intruded = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ partNumber: 1 })
      .expect(404);
    // resposta idêntica ao caso inexistente — não vaza existência
    expect(intruded.body).toEqual(missing.body);

    const missingList = await request(app.getHttpServer())
      .get('/videos/uploads/nao-existe00/parts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    expect((missingList.body as Record<string, string>).error).toBe(
      'UPLOAD_NOT_FOUND',
    );

    const intrudedList = await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);
    expect(intrudedList.body).toEqual(missingList.body);
  });

  it('upload-ja-completado', async () => {
    const { token } = await createAuthenticatedUser('owner');
    const videoId = await createUpload(token);
    await markCompleted(videoId);

    const response = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumber: 1 })
      .expect(409);
    expect((response.body as Record<string, string>).error).toBe(
      'UPLOAD_ALREADY_COMPLETED',
    );
  });
});
