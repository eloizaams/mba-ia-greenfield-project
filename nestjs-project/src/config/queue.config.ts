import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST ?? 'redis',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  // Namespace das chaves BullMQ no Redis. Testes usam um prefixo próprio para
  // não disputar jobs com o video-worker de desenvolvimento.
  prefix: process.env.QUEUE_PREFIX || 'bull',
}));
