import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_REQUESTED_JOB,
} from '../queue/queue.constants';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { PublicIdService } from './public-id.service';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let queue: Queue;
  let user: User;
  let channel: Channel;

  const fakeStorage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getSignedPartUrl: jest.fn().mockResolvedValue('http://signed/part'),
    listParts: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    // Prefixo próprio: sem ele o video-worker de desenvolvimento (mesma
    // instância Redis) consome os jobs publicados pelo teste.
    process.env.QUEUE_PREFIX = `test-int-${Date.now()}`;

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig],
          ignoreEnvFile: true,
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST,
          port: parseInt(process.env.DB_PORT ?? '5432', 10),
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          entities: [User, Channel, Video],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Video]),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [
        VideosService,
        PublicIdService,
        ChannelsService,
        { provide: StorageService, useValue: fakeStorage },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));

    const suffix = Date.now();
    user = await dataSource.getRepository(User).save({
      email: `videos-service-${suffix}@test.local`,
      password: 'irrelevant-hash',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Videos Service Test',
      nickname: `videos_svc_${suffix}`,
      user_id: user.id,
    });
  });

  beforeEach(async () => {
    fakeStorage.createMultipartUpload.mockReset();
    fakeStorage.createMultipartUpload.mockResolvedValue('upload-int-1');
    fakeStorage.completeMultipartUpload.mockReset();
    fakeStorage.completeMultipartUpload.mockResolvedValue(undefined);
    await queue.drain(true);
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM videos');
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM videos');
    await dataSource.getRepository(Channel).delete({ id: channel.id });
    await dataSource.getRepository(User).delete({ id: user.id });
    await queue.obliterate({ force: true });
    await moduleRef.close();
    delete process.env.QUEUE_PREFIX;
  });

  it('should persist the draft with channel, storageKey, uploadId and null editable fields', async () => {
    const result = await service.initiateUpload(user.id, {
      filename: 'aula-01.mp4',
      contentType: 'video/mp4',
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ publicId: result.videoId });

    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.channelId).toBe(channel.id);
    expect(row.uploadId).toBe('upload-int-1');
    expect(row.storageKey).toBe(result.storageKey);
    expect(row.title).toBeNull();
    expect(row.description).toBeNull();
    expect(row.category).toBeNull();
    expect(row.thumbnailKey).toBeNull();
  });

  it('should create drafts with distinct publicIds for concurrent uploads of the same user', async () => {
    const [first, second] = await Promise.all([
      service.initiateUpload(user.id, {
        filename: 'a.mp4',
        contentType: 'video/mp4',
      }),
      service.initiateUpload(user.id, {
        filename: 'b.mp4',
        contentType: 'video/mp4',
      }),
    ]);

    expect(first.videoId).not.toBe(second.videoId);
    const count = await dataSource.getRepository(Video).count();
    expect(count).toBe(2);
  });

  it('should not leave an orphan draft when the storage provider fails', async () => {
    fakeStorage.createMultipartUpload.mockRejectedValue(
      new Error('minio down'),
    );

    await expect(
      service.initiateUpload(user.id, {
        filename: 'fail.mp4',
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow('Storage provider failed');

    const count = await dataSource.getRepository(Video).count();
    expect(count).toBe(0);
  });

  it('should transition to processing, clear uploadId and publish exactly one job on complete', async () => {
    const initiated = await service.initiateUpload(user.id, {
      filename: 'complete-me.mp4',
      contentType: 'video/mp4',
    });

    const result = await service.completeUpload(user.id, initiated.videoId, [
      { partNumber: 1, eTag: 'etag-1' },
    ]);
    expect(result).toEqual({
      videoId: initiated.videoId,
      status: VideoStatus.PROCESSING,
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ publicId: initiated.videoId });
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

  it('should not publish a job when the storage fails to complete the multipart', async () => {
    const initiated = await service.initiateUpload(user.id, {
      filename: 'storage-fail.mp4',
      contentType: 'video/mp4',
    });
    fakeStorage.completeMultipartUpload.mockRejectedValue(
      new Error('minio down'),
    );

    await expect(
      service.completeUpload(user.id, initiated.videoId, [
        { partNumber: 1, eTag: 'etag-1' },
      ]),
    ).rejects.toThrow('Storage provider failed');

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ publicId: initiated.videoId });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(await queue.getWaiting()).toHaveLength(0);
  });

  it('should remove the draft and abort the multipart on abortUpload', async () => {
    const initiated = await service.initiateUpload(user.id, {
      filename: 'abort-me.mp4',
      contentType: 'video/mp4',
    });

    await service.abortUpload(user.id, initiated.videoId);

    expect(fakeStorage.abortMultipartUpload).toHaveBeenCalledWith(
      initiated.storageKey,
      'upload-int-1',
    );
    const count = await dataSource.getRepository(Video).count();
    expect(count).toBe(0);
    await expect(service.listParts(user.id, initiated.videoId)).rejects.toThrow(
      'Upload not found',
    );
  });
});
