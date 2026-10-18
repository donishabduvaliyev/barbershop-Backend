import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const MOBILE_TOKEN_TTL = '30d';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.TELEGRAM_BOT_TOKEN;
  if (!secret) {
    throw new Error('FATAL: Neither JWT_SECRET nor TELEGRAM_BOT_TOKEN is configured in the environment.');
  }
  return secret;
}

// Signs a long-lived JWT for the React Native (Android/iOS) mobile app
// after the customer authenticates via Telegram Bot Deep-Link or InitData.
export function signMobileCustomerToken({ telegramId, username = '', name = '' }) {
  return jwt.sign(
    {
      role: 'customer',
      platform: 'mobile',
      telegramId: Number(telegramId),
      username,
      name,
    },
    getJwtSecret(),
    { expiresIn: MOBILE_TOKEN_TTL }
  );
}

// Verifies a mobile customer JWT and returns the normalized user payload,
// or null if invalid/expired or not a customer token.
export function verifyMobileCustomerToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (!payload || payload.role !== 'customer' || !payload.telegramId) {
      return null;
    }
    return {
      id: Number(payload.telegramId),
      username: payload.username || '',
      first_name: payload.name || '',
    };
  } catch {
    return null;
  }
}

// Verifies Telegram WebApp initData per Telegram's documented algorithm:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
// Returns the authenticated Telegram user object, or null if invalid/missing.
export function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = Array.from(params.keys())
    .sort()
    .map((key) => `${key}=${params.get(key)}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuffer = Buffer.from(hash, 'hex');
  const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
  if (hashBuffer.length !== calculatedBuffer.length || !crypto.timingSafeEqual(hashBuffer, calculatedBuffer)) {
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

// Smart Dual-Platform Auth Middleware:
// Automatically detects whether the request comes from:
// 1. Web (Telegram Mini App) via HMAC-signed `initData` / `x-telegram-init-data`
// 2. Mobile (React Native Android/iOS) via `Authorization: Bearer <jwt>` or `x-mobile-token`
// Attaches `req.telegramUser` and `req.clientPlatform` ('web' | 'mobile').
export function requireTelegramAuth(req, res, next) {
  // 1. Check Web Mini App initData first
  const initData = req.body?.initData || req.headers['x-telegram-init-data'];
  if (initData) {
    const user = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (user) {
      req.telegramUser = user;
      req.clientPlatform = 'web';
      return next();
    }
  }

  // 2. Check Mobile App Bearer JWT token
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const mobileToken = bearerToken || req.headers['x-mobile-token'];
  if (mobileToken) {
    const mobileUser = verifyMobileCustomerToken(mobileToken);
    if (mobileUser) {
      req.telegramUser = mobileUser;
      req.clientPlatform = 'mobile';
      return next();
    }
  }

  return res.status(401).json({ message: 'Please log in with Telegram to continue.' });
}

