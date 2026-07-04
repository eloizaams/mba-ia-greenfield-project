import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource } from 'typeorm';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { VideoProcessingJobPayload } from '../queue/queue.constants';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const execFileAsync = promisify(execFile);

const buildJob = (
  videoId: string,
  storageKey: string,
  attemptsMade = 0,
  attempts = 3,
): Job<VideoProcessingJobPayload> =>
  ({
    data: { videoId, storageKey },
    attemptsMade,
    opts: { attempts },
  }) as Job<VideoProcessingJobPayload>;

describe('VideoProcessingProcessor (integration — MinIO + Postgres + ffmpeg)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let storageService: StorageService;
  let dataSource: DataSource;
  let user: User;
  let channel: Channel;
  let fixtureDir: string;
  let storageKey: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
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
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessingProcessor],
    }).compile();

    processor = moduleRef.get(VideoProcessingProcessor);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);

    const suffix = Date.now();
    user = await dataSource.getRepository(User).save({
      email: `processor-${suffix}@test.local`,
      password: 'irrelevant-hash',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Processor Test',
      nickname: `processor_${suffix}`,
      user_id: user.id,
    });

    // Fixture real gerada via lavfi e subida para o MinIO
    fixtureDir = await mkdtemp(join(tmpdir(), 'processor-fixture-'));
    const fixturePath = join(fixtureDir, 'fixture.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=4:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
    storageKey = `videos/processor-test/${randomUUID()}.mp4`;
    await storageService.putObject(
      storageKey,
      await readFile(fixturePath),
      'video/mp4',
    );
  }, 60000);

  afterEach(async () => {
    await dataSource.query('DELETE FROM videos');
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM videos');
    await dataSource.getRepository(Channel).delete({ id: channel.id });
    await dataSource.getRepository(User).delete({ id: user.id });
    await rm(fixtureDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  const createProcessingVideo = async (key: string): Promise<Video> =>
    dataSource.getRepository(Video).save({
      publicId: randomUUID().replace(/-/g, '').slice(0, 11),
      channelId: channel.id,
      storageKey: key,
      status: VideoStatus.PROCESSING,
    });

  it('should process the job end-to-end: ready + duration + metadata + thumbnail in the bucket', async () => {
    const video = await createProcessingVideo(storageKey);

    await processor.process(buildJob(video.id, storageKey));

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.durationSeconds).toBeGreaterThanOrEqual(3);
    expect(row.durationSeconds).toBeLessThanOrEqual(5);
    expect(row.metadata).toMatchObject({ width: 320, height: 240 });
    expect(row.thumbnailKey).toBe(`thumbnails/${row.publicId}.jpg`);

    const thumbnailStream = await storageService.getObjectStream(
      row.thumbnailKey as string,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of thumbnailStream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });

  it('should mark the video failed when the object is missing and retries are exhausted', async () => {
    const missingKey = `videos/processor-test/missing-${randomUUID()}.mp4`;
    const video = await createProcessingVideo(missingKey);

    await expect(
      processor.process(buildJob(video.id, missingKey, 2, 3)),
    ).rejects.toThrow();

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
  });

  it('should not reprocess an already-ready video on redelivery', async () => {
    const video = await createProcessingVideo(storageKey);
    await processor.process(buildJob(video.id, storageKey));

    const putSpy = jest.spyOn(storageService, 'putObject');
    await processor.process(buildJob(video.id, storageKey, 1));

    expect(putSpy).not.toHaveBeenCalled();
    putSpy.mockRestore();
  });
});
