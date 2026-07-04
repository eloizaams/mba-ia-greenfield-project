import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

describe('QueueModule', () => {
  it('should compile with the BullMQ connection configured from queueConfig', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig],
          ignoreEnvFile: true,
        }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
    }).compile();

    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);

    await queue.close();
    await moduleRef.close();
  });
});
