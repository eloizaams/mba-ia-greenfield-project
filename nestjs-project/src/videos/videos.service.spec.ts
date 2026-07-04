import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_REQUESTED_JOB,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  StorageProvisioningException,
  UploadAlreadyCompletedException,
  UploadNotFoundException,
} from './exceptions/video.exceptions';
import { PublicIdService } from './public-id.service';
import { VideosService } from './videos.service';
import { PUBLIC_ID_LENGTH } from './videos.constants';

const CHANNEL = { id: 'channel-uuid-1' };

const ownedUpload = (): Partial<Video> => ({
  id: 'video-uuid-1',
  publicId: 'pub12345678',
  status: VideoStatus.DRAFT,
  storageKey: 'videos/pub12345678/a.mp4',
  uploadId: 'upload-id-1',
  channel: { id: CHANNEL.id, user_id: 'user-1' } as Video['channel'],
});

const publicIdCollision = () =>
  Object.assign(new Error('duplicate key value violates unique constraint'), {
    driverError: {
      code: '23505',
      detail: 'Key (public_id)=(x) already exists.',
    },
  });

describe('VideosService', () => {
  let service: VideosService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    getSignedPartUrl: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    repository = {
      create: jest.fn((input: Partial<Video>) => input),
      save: jest.fn((input: Partial<Video>) => Promise.resolve(input)),
      findOne: jest.fn().mockResolvedValue(ownedUpload()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    channelsService = { findByUserId: jest.fn().mockResolvedValue(CHANNEL) };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      getSignedPartUrl: jest.fn().mockResolvedValue('http://signed/part'),
      listParts: jest
        .fn()
        .mockResolvedValue([{ partNumber: 1, eTag: 'etag-1' }]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        PublicIdService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: queue,
        },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('initiateUpload', () => {
    const input = { filename: 'my-video.mp4', contentType: 'video/mp4' };

    it('should create the multipart upload and persist a draft (happy path)', async () => {
      const result = await service.initiateUpload('user-1', input);

      expect(result.videoId).toHaveLength(PUBLIC_ID_LENGTH);
      expect(result.uploadId).toBe('upload-id-1');
      expect(result.storageKey).toBe(`videos/${result.videoId}/my-video.mp4`);
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        result.storageKey,
        'video/mp4',
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          publicId: result.videoId,
          channelId: CHANNEL.id,
          storageKey: result.storageKey,
          uploadId: 'upload-id-1',
        }),
      );
    });

    it('should sanitize unsafe filenames before composing the storageKey', async () => {
      const result = await service.initiateUpload('user-1', {
        filename: '../weird name!!.mp4',
        contentType: 'video/mp4',
      });

      expect(result.storageKey).toBe(
        `videos/${result.videoId}/weird_name__.mp4`,
      );
    });

    it('should throw STORAGE_PROVISIONING_ERROR and persist nothing when the storage fails', async () => {
      storageService.createMultipartUpload.mockRejectedValue(
        new Error('minio down'),
      );

      await expect(service.initiateUpload('user-1', input)).rejects.toThrow(
        StorageProvisioningException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload when persistence fails for a non-collision reason', async () => {
      const dbError = Object.assign(new Error('db down'), {
        driverError: { code: '57P01' },
      });
      repository.save.mockRejectedValue(dbError);

      await expect(service.initiateUpload('user-1', input)).rejects.toThrow(
        'db down',
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should retry with a fresh publicId (and abort the orphan multipart) on collision', async () => {
      repository.save
        .mockRejectedValueOnce(publicIdCollision())
        .mockImplementation((video: Partial<Video>) => Promise.resolve(video));

      const result = await service.initiateUpload('user-1', input);

      expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(2);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
      const [firstKey] = storageService.createMultipartUpload.mock.calls[0] as [
        string,
      ];
      const [secondKey] = storageService.createMultipartUpload.mock
        .calls[1] as [string];
      expect(firstKey).not.toBe(secondKey);
      expect(result.storageKey).toBe(secondKey);
    });

    it('should fail with an invariant error when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload('user-1', input)).rejects.toThrow(
        'has no channel',
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('ownership/state guards (signPart, listParts, completeUpload, abortUpload)', () => {
    it('should sign a part URL for the owned in-progress upload', async () => {
      const url = await service.signPart('user-1', 'pub12345678', 3);

      expect(url).toBe('http://signed/part');
      expect(storageService.getSignedPartUrl).toHaveBeenCalledWith(
        'videos/pub12345678/a.mp4',
        'upload-id-1',
        3,
      );
    });

    it('should list uploaded parts for the owned in-progress upload', async () => {
      const parts = await service.listParts('user-1', 'pub12345678');

      expect(parts).toEqual([{ partNumber: 1, eTag: 'etag-1' }]);
      expect(storageService.listParts).toHaveBeenCalledWith(
        'videos/pub12345678/a.mp4',
        'upload-id-1',
      );
    });

    it('should throw UPLOAD_NOT_FOUND when the video does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.signPart('user-1', 'missing00000', 1),
      ).rejects.toThrow(UploadNotFoundException);
    });

    it('should throw UPLOAD_NOT_FOUND (indistinguishable) when the upload belongs to another user', async () => {
      await expect(
        service.signPart('intruder-9', 'pub12345678', 1),
      ).rejects.toThrow(UploadNotFoundException);
    });

    it('should throw UPLOAD_ALREADY_COMPLETED when uploadId has been cleared', async () => {
      repository.findOne.mockResolvedValue({
        ...ownedUpload(),
        status: VideoStatus.PROCESSING,
        uploadId: null,
      });

      await expect(
        service.signPart('user-1', 'pub12345678', 1),
      ).rejects.toThrow(UploadAlreadyCompletedException);
      await expect(
        service.completeUpload('user-1', 'pub12345678', []),
      ).rejects.toThrow(UploadAlreadyCompletedException);
      await expect(
        service.abortUpload('user-1', 'pub12345678'),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, eTag: 'etag-1' }];

    it('should complete the multipart, transition to processing and enqueue after the update', async () => {
      const result = await service.completeUpload(
        'user-1',
        'pub12345678',
        parts,
      );

      expect(result).toEqual({
        videoId: 'pub12345678',
        status: VideoStatus.PROCESSING,
      });
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/pub12345678/a.mp4',
        'upload-id-1',
        parts,
      );
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-uuid-1' },
        { status: VideoStatus.PROCESSING, uploadId: null },
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(VIDEO_PROCESSING_REQUESTED_JOB, {
        videoId: 'video-uuid-1',
        storageKey: 'videos/pub12345678/a.mp4',
      });
      // enqueue estritamente após o commit do update
      const updateOrder = repository.update.mock.invocationCallOrder[0];
      const addOrder = queue.add.mock.invocationCallOrder[0];
      expect(addOrder).toBeGreaterThan(updateOrder);
    });

    it('should not enqueue when the status update fails', async () => {
      repository.update.mockRejectedValue(new Error('db down'));

      await expect(
        service.completeUpload('user-1', 'pub12345678', parts),
      ).rejects.toThrow('db down');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should throw STORAGE_PROVISIONING_ERROR without updating or enqueueing when the storage fails', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new Error('minio down'),
      );

      await expect(
        service.completeUpload('user-1', 'pub12345678', parts),
      ).rejects.toThrow(StorageProvisioningException);
      expect(repository.update).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart on storage and remove the draft', async () => {
      await service.abortUpload('user-1', 'pub12345678');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/pub12345678/a.mp4',
        'upload-id-1',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-uuid-1' });
    });

    it('should keep the draft when the storage abort fails', async () => {
      storageService.abortMultipartUpload.mockRejectedValue(
        new Error('minio down'),
      );

      await expect(
        service.abortUpload('user-1', 'pub12345678'),
      ).rejects.toThrow(StorageProvisioningException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});
