import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UploadNotFoundException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_FOUND', 404, 'Upload not found');
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_ALREADY_COMPLETED',
      409,
      'Upload has already been completed or aborted',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}

export class StorageProvisioningException extends DomainException {
  constructor() {
    super(
      'STORAGE_PROVISIONING_ERROR',
      502,
      'Storage provider failed to process the upload',
    );
  }
}
