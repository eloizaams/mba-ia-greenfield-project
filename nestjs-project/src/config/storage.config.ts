import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://storage:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
  bucket: process.env.STORAGE_BUCKET || 'videos',
  presignedExpirySeconds: parseInt(
    process.env.STORAGE_PRESIGNED_EXPIRY_SECONDS ?? '3600',
    10,
  ),
}));
