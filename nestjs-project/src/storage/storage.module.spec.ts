import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import { STORAGE_CLIENT, STORAGE_PUBLIC_CLIENT } from './storage.constants';

describe('StorageModule', () => {
  it('should compile and resolve StorageService with both S3 clients', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
          ignoreEnvFile: true,
        }),
        StorageModule,
      ],
    }).compile();

    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
    expect(moduleRef.get(STORAGE_CLIENT)).toBeInstanceOf(S3Client);
    expect(moduleRef.get(STORAGE_PUBLIC_CLIENT)).toBeInstanceOf(S3Client);

    await moduleRef.close();
  });
});
