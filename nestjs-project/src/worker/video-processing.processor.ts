import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import type { VideoProcessingJobPayload } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg/ffmpeg.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobPayload>): Promise<void> {
    const { videoId, storageKey } = job.data;

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      // Draft abortado/removido entre o enqueue e o consumo — nada a fazer.
      return;
    }
    if (video.status === VideoStatus.READY) {
      // Redelivery (at-least-once, per phase-03-videos/TD-03) — no-op seguro.
      return;
    }

    try {
      await this.processVideo(video, storageKey);
    } catch (error) {
      // Contexto de background: rethrow devolve o job para retry/backoff da
      // fila; na última tentativa o vídeo é marcado como failed.
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= maxAttempts) {
        await this.videoRepository.update(
          { id: video.id },
          { status: VideoStatus.FAILED },
        );
      }
      throw error;
    }
  }

  private async processVideo(video: Video, storageKey: string): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
    try {
      const inputPath = join(workDir, 'input');
      const objectStream =
        await this.storageService.getObjectStream(storageKey);
      await pipeline(objectStream, createWriteStream(inputPath));

      const probe = await this.ffmpegService.probe(inputPath);

      const thumbnailPath = join(workDir, 'thumbnail.jpg');
      await this.ffmpegService.extractThumbnail(
        inputPath,
        thumbnailPath,
        probe.durationSeconds,
      );

      const thumbnailKey = `thumbnails/${video.publicId}.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      // Cast no boundary: QueryDeepPartialEntity não aceita Record<string,
      // unknown> para colunas jsonb (limitação de tipos do TypeORM).
      await this.videoRepository.update({ id: video.id }, {
        status: VideoStatus.READY,
        durationSeconds: probe.durationSeconds,
        metadata: probe.metadata,
        thumbnailKey,
      } as QueryDeepPartialEntity<Video>);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
