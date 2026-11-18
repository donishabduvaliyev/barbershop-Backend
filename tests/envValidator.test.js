import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnv } from '../config/envValidator.js';

describe('Production Environment Validator', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('bypasses validation cleanly in test mode by default', () => {
    delete process.env.MONGO_URI;
    const res = validateEnv({ isTest: true });
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('fails validation when MONGO_URI is missing', () => {
    delete process.env.MONGO_URI;
    const res = validateEnv({ isTest: false });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('MONGO_URI is missing. Backend cannot connect to the database.');
  });

  it('warns when bot tokens are not configured and polling is active', () => {
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SHOP_CONTROL_BOT_TOKEN;
    process.env.DISABLE_TELEGRAM_POLLING = 'false';

    const res = validateEnv({ isTest: false });
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('TELEGRAM_BOT_TOKEN is not set'),
        expect.stringContaining('SHOP_CONTROL_BOT_TOKEN is not set'),
      ])
    );
  });

  it('throws in production if critical environment variables are absent', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MONGO_URI;
    delete process.env.JWT_SECRET;

    expect(() => validateEnv({ isTest: false })).toThrow(/Environment validation failed/);
  });

  it('passes cleanly when all production variables are provided', () => {
    process.env.NODE_ENV = 'production';
    process.env.MONGO_URI = 'mongodb+srv://user:pass@cluster.mongodb.net/prod';
    process.env.JWT_SECRET = 'super-secret-cryptographically-secure-key-32chars';
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF';
    process.env.SHOP_CONTROL_BOT_TOKEN = '654321:XYZ-UVW';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'test-bucket';

    const res = validateEnv({ isTest: false });
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });
});
