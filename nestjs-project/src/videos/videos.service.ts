import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_REQUESTED_JOB,
} from '../queue/queue.constants';
import type { VideoProcessingJobPayload } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import type { UploadedPart } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  StorageProvisioningException,
  UploadAlreadyCompletedException,
  UploadNotFoundException,
} from './exceptions/video.exceptions';
import { PublicIdService } from './public-id.service';

export interface InitiateUploadInput {
  filename: string;
  contentType: string;
}

export interface InitiateUploadResult {
  videoId: string;
  uploadId: string;
  storageKey: string;
}

const sanitizeFilename = (filename: string): string => {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.replace(/^[._]+/, '') || 'video';
};

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly publicIdService: PublicIdService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue,
  ) {}

  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Invariante: o cadastro cria o canal na mesma transação do usuário.
      throw new Error(`Authenticated user ${userId} has no channel`);
    }

    const filename = sanitizeFilename(input.filename);

    return this.publicIdService.persistWithRetry(async (publicId) => {
      const storageKey = `videos/${publicId}/${filename}`;

      let uploadId: string;
      try {
        uploadId = await this.storageService.createMultipartUpload(
          storageKey,
          input.contentType,
        );
      } catch {
        throw new StorageProvisioningException();
      }

      try {
        const video = await this.videoRepository.save(
          this.videoRepository.create({
            publicId,
            channelId: channel.id,
            storageKey,
            uploadId,
          }),
        );
        return {
          videoId: video.publicId,
          uploadId,
          storageKey,
        };
      } catch (error) {
        // Compensação best-effort: sem o draft não pode sobrar multipart órfão.
        await this.storageService
          .abortMultipartUpload(storageKey, uploadId)
          .catch(() => undefined);
        throw error;
      }
    });
  }

  async signPart(
    userId: string,
    videoId: string,
    partNumber: number,
  ): Promise<string> {
    const video = await this.findOwnedUpload(userId, videoId);
    return this.storageService.getSignedPartUrl(
      video.storageKey,
      video.uploadId as string,
      partNumber,
    );
  }

  async listParts(userId: string, videoId: string): Promise<UploadedPart[]> {
    const video = await this.findOwnedUpload(userId, videoId);
    return this.storageService.listParts(
      video.storageKey,
      video.uploadId as string,
    );
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: UploadedPart[],
  ): Promise<{ videoId: string; status: VideoStatus }> {
    const video = await this.findOwnedUpload(userId, videoId);

    try {
      await this.storageService.completeMultipartUpload(
        video.storageKey,
        video.uploadId as string,
        parts,
      );
    } catch {
      throw new StorageProvisioningException();
    }

    await this.videoRepository.update(
      { id: video.id },
      { status: VideoStatus.PROCESSING, uploadId: null },
    );

    // Publica somente após o commit do update acima (per phase-03-videos/TD-03
    // — transactional-enqueue gap: a fila nunca vê um vídeo ainda em draft).
    const payload: VideoProcessingJobPayload = {
      videoId: video.id,
      storageKey: video.storageKey,
    };
    await this.processingQueue.add(VIDEO_PROCESSING_REQUESTED_JOB, payload);

    return { videoId: video.publicId, status: VideoStatus.PROCESSING };
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedUpload(userId, videoId);

    try {
      await this.storageService.abortMultipartUpload(
        video.storageKey,
        video.uploadId as string,
      );
    } catch {
      throw new StorageProvisioningException();
    }

    await this.videoRepository.delete({ id: video.id });
  }

  // Estado do upload em andamento: draft com uploadId presente. Vídeo
  // inexistente e vídeo de outro dono respondem igual (404, sem vazar
  // existência); uploadId limpo ou status pós-draft respondem 409.
  private async findOwnedUpload(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { publicId },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new UploadNotFoundException();
    }
    if (video.status !== VideoStatus.DRAFT || !video.uploadId) {
      throw new UploadAlreadyCompletedException();
    }
    return video;
  }
}
