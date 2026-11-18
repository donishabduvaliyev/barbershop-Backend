/**
 * Fail-Fast Production Environment Validator
 * Inspects system environment variables on boot and prevents silent corrupted runs.
 */

export function validateEnv({ isTest = process.env.NODE_ENV === 'test' } = {}) {
  const errors = [];
  const warnings = [];

  // In test environments, tests manage their own in-memory state
  if (isTest) {
    return { valid: true, errors, warnings };
  }

  // 1. Database Connection
  if (!process.env.MONGO_URI) {
    errors.push('MONGO_URI is missing. Backend cannot connect to the database.');
  }

  // 2. Authentication Secrets
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET) {
      errors.push('JWT_SECRET is required in production.');
    } else if (process.env.JWT_SECRET.length < 16) {
      warnings.push('JWT_SECRET is shorter than 16 characters. Consider using a 256-bit cryptographically secure string.');
    }
  }

  // 3. Telegram Bot Tokens
  if (process.env.DISABLE_TELEGRAM_POLLING !== 'true') {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      warnings.push('TELEGRAM_BOT_TOKEN is not set — customer booking bot will be disabled.');
    }
    if (!process.env.SHOP_CONTROL_BOT_TOKEN) {
      warnings.push('SHOP_CONTROL_BOT_TOKEN is not set — shop owner control bot will be disabled.');
    }
  }

  // 4. Cloudflare R2 / S3 Storage (Optional)
  const hasR2 = process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME;
  if (!hasR2 && process.env.NODE_ENV === 'production') {
    warnings.push('Cloudflare R2 storage credentials not fully configured — image uploads will fall back or fail.');
  }

  if (warnings.length > 0) {
    warnings.forEach((warn) => console.warn(`⚠️ [EnvValidator] ${warn}`));
  }

  if (errors.length > 0) {
    errors.forEach((err) => console.error(`❌ [EnvValidator] FATAL: ${err}`));
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Environment validation failed with ${errors.length} error(s). Process halted.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export default validateEnv;
