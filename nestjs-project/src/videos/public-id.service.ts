import { Injectable } from '@nestjs/common';
import { customAlphabet } from 'nanoid';
import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_MAX_ATTEMPTS,
} from './videos.constants';

const isPublicIdUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    code?: string;
    detail?: string;
    driverError?: { code?: string; detail?: string };
  };
  const code = candidate.driverError?.code ?? candidate.code;
  if (code !== '23505') {
    return false;
  }
  const detail = candidate.driverError?.detail ?? candidate.detail;
  // Sem detail (driver não expôs), assume colisão de publicId; com detail,
  // só retenta quando a violação é da coluna public_id.
  return detail === undefined || detail.includes('public_id');
};

@Injectable()
export class PublicIdService {
  private readonly generator = customAlphabet(
    PUBLIC_ID_ALPHABET,
    PUBLIC_ID_LENGTH,
  );

  generate(): string {
    return this.generator();
  }

  async persistWithRetry<T>(
    persist: (publicId: string) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      const publicId = this.generate();
      try {
        return await persist(publicId);
      } catch (error) {
        if (!isPublicIdUniqueViolation(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw new Error(
      `Failed to generate a unique publicId after ${PUBLIC_ID_MAX_ATTEMPTS} attempts`,
      { cause: lastError },
    );
  }
}
