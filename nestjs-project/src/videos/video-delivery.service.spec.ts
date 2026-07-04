import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { VideoDeliveryService } from './video-delivery.service';

const readyVideo = (): Partial<Video> => ({
  id: 'video-uuid-1',
  publicId: 'pub12345678',
  status: VideoStatus.READY,
  storageKey: 'videos/pub12345678/aula-01.mp4',
  channel: { id: 'channel-uuid-1', user_id: 'user-1' } as Video['channel'],
});

describe('VideoDeliveryService', () => {
  let service: VideoDeliveryService;
  let repository: { findOne: jest.Mock };
  let storageService: { getPresignedGetUrl: jest.Mock };

  beforeEach(async () => {
    repository = { findOne: jest.fn().mockResolvedValue(readyVideo()) };
    storageService = {
      getPresignedGetUrl: jest.fn().mockResolvedValue('http://signed/url'),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoDeliveryService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = moduleRef.get(VideoDeliveryService);
  });

  it('should return a presigned stream URL without download disposition', async () => {
    const url = await service.getStreamUrl('pub12345678', 'user-1');

    expect(url).toBe('http://signed/url');
    expect(storageService.getPresignedGetUrl).toHaveBeenCalledWith(
      'videos/pub12345678/aula-01.mp4',
    );
  });

  it('should return a download URL with the attachment filename derived from the storageKey', async () => {
    const url = await service.getDownloadUrl('pub12345678', 'user-1');

    expect(url).toBe('http://signed/url');
    expect(storageService.getPresignedGetUrl).toHaveBeenCalledWith(
      'videos/pub12345678/aula-01.mp4',
      { downloadFilename: 'aula-01.mp4' },
    );
  });

  it('should throw VIDEO_NOT_FOUND when the publicId does not exist', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(
      service.getStreamUrl('missing00000', 'user-1'),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('should throw VIDEO_NOT_FOUND (indistinguishable) when the video belongs to another user', async () => {
    await expect(
      service.getStreamUrl('pub12345678', 'intruder-9'),
    ).rejects.toThrow(VideoNotFoundException);
    await expect(
      service.getDownloadUrl('pub12345678', 'intruder-9'),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('should throw VIDEO_NOT_READY for every non-ready status', async () => {
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.FAILED,
    ]) {
      repository.findOne.mockResolvedValue({ ...readyVideo(), status });
      await expect(
        service.getStreamUrl('pub12345678', 'user-1'),
      ).rejects.toThrow(VideoNotReadyException);
    }
    expect(storageService.getPresignedGetUrl).not.toHaveBeenCalled();
  });
});
