import { Test } from '@nestjs/testing';
import { PublicIdService } from './public-id.service';
import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_MAX_ATTEMPTS,
} from './videos.constants';

const uniqueViolation = (detail?: string) =>
  Object.assign(new Error('duplicate key value violates unique constraint'), {
    driverError: { code: '23505', detail },
  });

describe('PublicIdService', () => {
  let service: PublicIdService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PublicIdService],
    }).compile();
    service = moduleRef.get(PublicIdService);
  });

  describe('generate', () => {
    it('should generate ids with exactly 11 characters from the configured alphabet', () => {
      const allowed = new Set(PUBLIC_ID_ALPHABET.split(''));
      for (let i = 0; i < 100; i++) {
        const id = service.generate();
        expect(id).toHaveLength(PUBLIC_ID_LENGTH);
        for (const char of id) {
          expect(allowed.has(char)).toBe(true);
        }
      }
    });

    it('should not produce sequential/repeated ids across calls', () => {
      const ids = new Set(
        Array.from({ length: 100 }, () => service.generate()),
      );
      expect(ids.size).toBe(100);
    });
  });

  describe('persistWithRetry', () => {
    it('should return the persisted result on first attempt (happy path)', async () => {
      const persist = jest.fn().mockResolvedValue({ id: 'row-1' });

      const result = await service.persistWithRetry(persist);

      expect(result).toEqual({ id: 'row-1' });
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledWith(expect.any(String));
    });

    it('should regenerate and retry when persistence hits a publicId unique violation', async () => {
      const persist = jest
        .fn()
        .mockRejectedValueOnce(
          uniqueViolation('Key (public_id)=(abc) already exists.'),
        )
        .mockResolvedValue({ id: 'row-2' });

      const result = await service.persistWithRetry(persist);

      expect(result).toEqual({ id: 'row-2' });
      expect(persist).toHaveBeenCalledTimes(2);
      const [firstId] = persist.mock.calls[0] as [string];
      const [secondId] = persist.mock.calls[1] as [string];
      expect(firstId).not.toBe(secondId);
    });

    it('should throw an explicit error after exhausting the attempt limit', async () => {
      const persist = jest
        .fn()
        .mockRejectedValue(
          uniqueViolation('Key (public_id)=(abc) already exists.'),
        );

      await expect(service.persistWithRetry(persist)).rejects.toThrow(
        `Failed to generate a unique publicId after ${PUBLIC_ID_MAX_ATTEMPTS} attempts`,
      );
      expect(persist).toHaveBeenCalledTimes(PUBLIC_ID_MAX_ATTEMPTS);
    });

    it('should rethrow immediately when the error is not a publicId unique violation', async () => {
      const fkViolation = Object.assign(new Error('fk violation'), {
        driverError: { code: '23503' },
      });
      const persist = jest.fn().mockRejectedValue(fkViolation);

      await expect(service.persistWithRetry(persist)).rejects.toThrow(
        'fk violation',
      );
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it('should rethrow a unique violation from a different column without retrying', async () => {
      const otherUnique = uniqueViolation(
        'Key (storage_key)=(x) already exists.',
      );
      const persist = jest.fn().mockRejectedValue(otherUnique);

      await expect(service.persistWithRetry(persist)).rejects.toThrow(
        'duplicate key',
      );
      expect(persist).toHaveBeenCalledTimes(1);
    });
  });
});
