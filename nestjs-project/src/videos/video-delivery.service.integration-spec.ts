import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';

describe('VideoDeliveryService (integration — MinIO + Postgres)', () => {
  let moduleRef: TestingModule;
  let service: VideoDeliveryService;
  let storageService: StorageService;
  let dataSource: DataSource;
  let user: User;
  let channel: Channel;
  let storageKey: string;

  const OBJECT_BODY = 'delivery-integration-payload-0123456789';

  beforeAll(async () => {
    // Dentro do container o endpoint browser-reachable é inalcançável;
    // assina contra o service name do Compose para poder exercitar as URLs.
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://storage:9000';

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
      providers: [VideoDeliveryService],
    }).compile();

    service = moduleRef.get(VideoDeliveryService);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);

    const suffix = Date.now();
    user = await dataSource.getRepository(User).save({
      email: `delivery-${suffix}@test.local`,
      password: 'irrelevant-hash',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Delivery Test',
      nickname: `delivery_${suffix}`,
      user_id: user.id,
    });

    // Sobe um objeto real via ciclo multipart do StorageService
    storageKey = `videos/delivery-test/${randomUUID()}.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      storageKey,
      'video/mp4',
    );
    const partUrl = await storageService.getSignedPartUrl(
      storageKey,
      uploadId,
      1,
    );
    await fetch(partUrl, { method: 'PUT', body: OBJECT_BODY });
    const parts = await storageService.listParts(storageKey, uploadId);
    await storageService.completeMultipartUpload(storageKey, uploadId, parts);
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM videos');
    await dataSource.getRepository(Channel).delete({ id: channel.id });
    await dataSource.getRepository(User).delete({ id: user.id });
    await moduleRef.close();
  });

  const createReadyVideo = async (): Promise<Video> =>
    dataSource.getRepository(Video).save({
      publicId: randomUUID().replace(/-/g, '').slice(0, 11),
      channelId: channel.id,
      storageKey,
      status: VideoStatus.READY,
    });

  it('should serve the stream URL with Range support (206 Partial Content)', async () => {
    const video = await createReadyVideo();

    const url = await service.getStreamUrl(video.publicId, user.id);
    const rangeResponse = await fetch(url, {
      headers: { Range: 'bytes=0-9' },
    });

    expect(rangeResponse.status).toBe(206);
    await expect(rangeResponse.text()).resolves.toBe(OBJECT_BODY.slice(0, 10));
    expect(rangeResponse.headers.get('content-range')).toContain('bytes 0-9');
  });

  it('should serve the download URL with Content-Disposition attachment', async () => {
    const video = await createReadyVideo();

    const url = await service.getDownloadUrl(video.publicId, user.id);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    await expect(response.text()).resolves.toBe(OBJECT_BODY);
  });
});
