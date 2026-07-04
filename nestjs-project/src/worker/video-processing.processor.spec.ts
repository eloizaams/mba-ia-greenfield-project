import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { VideoProcessingJobPayload } from '../queue/queue.constants';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const PROBE_RESULT = {
  durationSeconds: 42,
  metadata: {
    format: 'mp4',
    bitrate: 1000,
    width: 320,
    height: 240,
    codec: 'h264',
  },
};

const processingVideo = (): Partial<Video> => ({
  id: 'video-uuid-1',
  publicId: 'pub12345678',
  status: VideoStatus.PROCESSING,
  storageKey: 'videos/pub12345678/a.mp4',
});

const buildJob = (
  attemptsMade: number,
  attempts = 3,
): Job<VideoProcessingJobPayload> =>
  ({
    data: {
      videoId: 'video-uuid-1',
      storageKey: 'videos/pub12345678/a.mp4',
    },
    attemptsMade,
    opts: { attempts },
  }) as Job<VideoProcessingJobPayload>;

const listWorkDirs = async (): Promise<string[]> =>
  (await readdir(tmpdir())).filter((name) =>
    name.startsWith('video-processing-'),
  );

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let repository: { findOne: jest.Mock; update: jest.Mock };
  let storageService: {
    getObjectStream: jest.Mock;
    putObject: jest.Mock;
  };
  let ffmpegService: { probe: jest.Mock; extractThumbnail: jest.Mock };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn().mockResolvedValue(processingVideo()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storageService = {
      getObjectStream: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(Readable.from(Buffer.from('video-bytes'))),
        ),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpegService = {
      probe: jest.fn().mockResolvedValue(PROBE_RESULT),
      extractThumbnail: jest
        .fn()
        .mockImplementation(async (_input: string, outPath: string) => {
          await writeFile(outPath, 'fake-jpg-bytes');
        }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();

    processor = moduleRef.get(VideoProcessingProcessor);
  });

  it('should download, probe, upload the thumbnail and mark the video ready', async () => {
    await processor.process(buildJob(0));

    expect(storageService.getObjectStream).toHaveBeenCalledWith(
      'videos/pub12345678/a.mp4',
    );
    expect(storageService.putObject).toHaveBeenCalledWith(
      'thumbnails/pub12345678.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-uuid-1' },
      {
        status: VideoStatus.READY,
        durationSeconds: 42,
        metadata: PROBE_RESULT.metadata,
        thumbnailKey: 'thumbnails/pub12345678.jpg',
      },
    );
  });

  it('should be a safe no-op when the video row no longer exists (aborted draft)', async () => {
    repository.findOne.mockResolvedValue(null);

    await processor.process(buildJob(0));

    expect(storageService.getObjectStream).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should be idempotent on redelivery of an already-ready video (at-least-once)', async () => {
    repository.findOne.mockResolvedValue({
      ...processingVideo(),
      status: VideoStatus.READY,
    });

    await processor.process(buildJob(1));

    expect(storageService.getObjectStream).not.toHaveBeenCalled();
    expect(storageService.putObject).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should rethrow without marking failed while attempts remain', async () => {
    storageService.getObjectStream.mockRejectedValue(
      new Error('object missing'),
    );

    await expect(processor.process(buildJob(0, 3))).rejects.toThrow(
      'object missing',
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should mark the video failed on the final attempt and still rethrow', async () => {
    storageService.getObjectStream.mockRejectedValue(
      new Error('object missing'),
    );

    await expect(processor.process(buildJob(2, 3))).rejects.toThrow(
      'object missing',
    );
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-uuid-1' },
      { status: VideoStatus.FAILED },
    );
  });

  it('should clean the temp work dir on success and on failure', async () => {
    const before = await listWorkDirs();

    await processor.process(buildJob(0));

    ffmpegService.probe.mockRejectedValue(new Error('corrupted'));
    await expect(processor.process(buildJob(0, 3))).rejects.toThrow(
      'corrupted',
    );

    const after = await listWorkDirs();
    expect(after).toEqual(before);
  });
});
