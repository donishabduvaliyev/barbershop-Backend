import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  verifyTelegramInitData,
  signMobileCustomerToken,
  verifyMobileCustomerToken,
  requireTelegramAuth,
} from '../middleware/telegramAuth.js';

const TEST_BOT_TOKEN = '123456789:ABCDEF_test_bot_token_for_hmac';

function buildSignedInitData(userObj, botToken = TEST_BOT_TOKEN) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(userObj));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));

  const dataCheckString = Array.from(params.keys())
    .sort()
    .map((k) => `${k}=${params.get(k)}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('Dual-Platform Customer Auth (Web Telegram InitData + Mobile JWT)', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
    process.env.JWT_SECRET = 'test-jwt-secret-key';
  });

  it('signs and verifies a mobile customer JWT', () => {
    const token = signMobileCustomerToken({
      telegramId: 99887766,
      username: 'aziz_uz',
      name: 'Azizbek',
    });

    const verified = verifyMobileCustomerToken(token);
    expect(verified).toEqual({
      id: 99887766,
      username: 'aziz_uz',
      first_name: 'Azizbek',
    });
  });

  it('auto-switches to web platform when valid x-telegram-init-data is provided', () => {
    const initData = buildSignedInitData({ id: 55443322, first_name: 'Sardor', username: 'sardor' });
    const req = { headers: { 'x-telegram-init-data': initData }, body: {} };
    let nextCalled = false;
    const res = {
      status: () => ({ json: () => {} }),
    };

    requireTelegramAuth(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.clientPlatform).toBe('web');
    expect(req.telegramUser.id).toBe(55443322);
  });

  it('auto-switches to mobile platform when valid Bearer JWT is provided', () => {
    const token = signMobileCustomerToken({
      telegramId: 11223344,
      username: 'mobile_user',
      name: 'Jasur',
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    };
    let nextCalled = false;
    const res = {
      status: () => ({ json: () => {} }),
    };

    requireTelegramAuth(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.clientPlatform).toBe('mobile');
    expect(req.telegramUser.id).toBe(11223344);
    expect(req.telegramUser.username).toBe('mobile_user');
  });

  it('rejects unauthenticated requests with 401', () => {
    const req = { headers: {}, body: {} };
    let statusCode = null;
    const res = {
      status: (code) => {
        statusCode = code;
        return { json: () => {} };
      },
    };

    requireTelegramAuth(req, res, () => {});
    expect(statusCode).toBe(401);
  });
});
