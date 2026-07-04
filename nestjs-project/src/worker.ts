import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  const appContext = await NestFactory.createApplicationContext(WorkerModule);
  appContext.enableShutdownHooks();
}
void bootstrap();
