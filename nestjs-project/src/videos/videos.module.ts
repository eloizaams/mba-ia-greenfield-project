import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { PublicIdService } from './public-id.service';
import { VideoDeliveryService } from './video-delivery.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      // Retry/backoff per phase-03-videos/TD-03 (at-least-once): o job de
      // FFmpeg é longo — backoff exponencial evita martelar o worker.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
      },
    }),
    ChannelsModule,
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [PublicIdService, VideoDeliveryService, VideosService],
})
export class VideosModule {}
