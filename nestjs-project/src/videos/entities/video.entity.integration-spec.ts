import 'dotenv/config';
import { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let user: User;

  const buildVideo = (overrides: Partial<Video> = {}): Video =>
    videoRepository.create({
      publicId: randomUUID().replace(/-/g, '').slice(0, 11),
      channelId: channel.id,
      storageKey: `videos/test/${randomUUID()}.mp4`,
      ...overrides,
    });

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [User, Channel, Video],
    });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);

    const suffix = Date.now();
    user = await dataSource.getRepository(User).save({
      email: `video-entity-${suffix}@test.local`,
      password: 'irrelevant-hash',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Video Entity Test',
      nickname: `video_entity_${suffix}`,
      user_id: user.id,
    });
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM videos');
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM videos');
    await dataSource.getRepository(Channel).delete({ id: channel.id });
    await dataSource.getRepository(User).delete({ id: user.id });
    await dataSource.destroy();
  });

  it('should persist with default status draft and nullable columns unset', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.uploadId).toBeNull();
    expect(found.title).toBeNull();
    expect(found.description).toBeNull();
    expect(found.category).toBeNull();
    expect(found.thumbnailKey).toBeNull();
    expect(found.durationSeconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(found.updatedAt).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same publicId (unique constraint)', async () => {
    const publicId = 'dupetest0001'.slice(0, 11);
    await videoRepository.save(buildVideo({ publicId }));

    await expect(
      videoRepository.save(buildVideo({ publicId })),
    ).rejects.toThrow(/duplicate key|UQ_/i);
  });

  it('should reject a video whose channelId does not reference a channel (FK)', async () => {
    await expect(
      videoRepository.save(buildVideo({ channelId: randomUUID() })),
    ).rejects.toThrow(/foreign key|FK_/i);
  });

  it('should load the channel relation through channel_id', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });
    expect(found.channel.id).toBe(channel.id);
    expect(found.channel.nickname).toBe(channel.nickname);
  });
});
