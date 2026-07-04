import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

type EnvValidation = {
  error?: ValidationError;
  value: Record<string, unknown>;
};

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY_ID: 'access-key',
  STORAGE_SECRET_ACCESS_KEY: 'secret-key',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
};

const validate = (env: Record<string, string>): EnvValidation =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as unknown as EnvValidation;

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — REDIS_*', () => {
  const validateWithout = (omittedKey: string): EnvValidation => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[omittedKey];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    }) as unknown as EnvValidation;
  };

  it('should reject when REDIS_HOST is missing', () => {
    const { error } = validateWithout('REDIS_HOST');
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_HOST');
  });

  it('should reject when REDIS_PORT is missing', () => {
    const { error } = validateWithout('REDIS_PORT');
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });

  it('should reject a non-numeric REDIS_PORT', () => {
    const { error } = validate({ REDIS_PORT: 'not-a-port' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('envValidationSchema — STORAGE_*', () => {
  const validateWithout = (omittedKey: string): EnvValidation => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[omittedKey];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    }) as unknown as EnvValidation;
  };

  it('should reject when STORAGE_ACCESS_KEY_ID is missing', () => {
    const { error } = validateWithout('STORAGE_ACCESS_KEY_ID');
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY_ID');
  });

  it('should reject when STORAGE_SECRET_ACCESS_KEY is missing', () => {
    const { error } = validateWithout('STORAGE_SECRET_ACCESS_KEY');
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_ACCESS_KEY');
  });

  it('should reject STORAGE_ENDPOINT that is not a valid URI', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should reject non-positive STORAGE_PRESIGNED_EXPIRY_SECONDS', () => {
    const { error } = validate({ STORAGE_PRESIGNED_EXPIRY_SECONDS: '0' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_PRESIGNED_EXPIRY_SECONDS');
  });

  it('should apply defaults for optional storage keys', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://storage:9000');
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_BUCKET).toBe('videos');
    expect(value.STORAGE_PRESIGNED_EXPIRY_SECONDS).toBe(3600);
  });
});
