import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';

@Injectable()
export class VideoDeliveryService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async getStreamUrl(publicId: string, userId: string): Promise<string> {
    const video = await this.findOwnedReadyVideo(publicId, userId);
    return this.storageService.getPresignedGetUrl(video.storageKey);
  }

  async getDownloadUrl(publicId: string, userId: string): Promise<string> {
    const video = await this.findOwnedReadyVideo(publicId, userId);
    const filename =
      video.storageKey.split('/').pop() || `${video.publicId}.mp4`;
    return this.storageService.getPresignedGetUrl(video.storageKey, {
      downloadFilename: filename,
    });
  }

  // Owner-only nesta fase (per Authorization Matrix — não há estado de
  // visibilidade até a Fase 04/05). Inexistente e outro dono respondem o
  // mesmo 404, sem vazar existência.
  private async findOwnedReadyVideo(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { publicId },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }
}
