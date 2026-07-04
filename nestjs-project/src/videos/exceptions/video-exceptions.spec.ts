import { DomainException } from '../../common/exceptions/domain.exception';
import {
  StorageProvisioningException,
  UploadAlreadyCompletedException,
  UploadNotFoundException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';

describe('Video domain exceptions', () => {
  // errorCode + HTTP status verbatim do Error Catalog da Fase 03
  const catalog: Array<{
    exception: DomainException;
    errorCode: string;
    httpStatus: number;
  }> = [
    {
      exception: new VideoNotFoundException(),
      errorCode: 'VIDEO_NOT_FOUND',
      httpStatus: 404,
    },
    {
      exception: new UploadNotFoundException(),
      errorCode: 'UPLOAD_NOT_FOUND',
      httpStatus: 404,
    },
    {
      exception: new UploadAlreadyCompletedException(),
      errorCode: 'UPLOAD_ALREADY_COMPLETED',
      httpStatus: 409,
    },
    {
      exception: new VideoNotReadyException(),
      errorCode: 'VIDEO_NOT_READY',
      httpStatus: 409,
    },
    {
      exception: new StorageProvisioningException(),
      errorCode: 'STORAGE_PROVISIONING_ERROR',
      httpStatus: 502,
    },
  ];

  it.each(catalog.map((c) => [c.errorCode, c]))(
    'should map %s to the Error Catalog statusCode and errorCode',
    (_name, entry) => {
      expect(entry.exception).toBeInstanceOf(DomainException);
      expect(entry.exception.errorCode).toBe(entry.errorCode);
      expect(entry.exception.httpStatus).toBe(entry.httpStatus);
      expect(entry.exception.message).not.toContain('at '); // sem stack na message
      expect(entry.exception.message.length).toBeGreaterThan(0);
    },
  );

  it('should not leak internal details in messages', () => {
    for (const { exception } of catalog) {
      expect(exception.message).not.toMatch(/postgres|sql|aws|s3|minio/i);
    }
  });
});
