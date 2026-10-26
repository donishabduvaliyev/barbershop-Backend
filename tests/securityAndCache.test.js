import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { verifyTelegramInitData } from '../middleware/telegramAuth.js';
import { sanitizeRequest } from '../middleware/sanitize.js';
import { MemoryCache } from '../utils/cache.js';
import { getCached, setCached, delCached, delCachedPrefix, invalidateShopCache } from '../utils/simpleCache.js';

function generateSignedInitData(userObj, botToken, authDateOffsetSeconds = 0) {
  const authDate = Math.floor(Date.now() / 1000) + authDateOffsetSeconds;
  const userStr = JSON.stringify(userObj);

  const params = {
    auth_date: String(authDate),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: userStr,
  };

  const dataCheckString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const urlParams = new URLSearchParams(params);
  urlParams.set('hash', hash);
  return urlParams.toString();
}

describe('Security Hardening: Telegram initData Replay Attack Defense', () => {
  const botToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
  const mockUser = { id: 987654321, first_name: 'Alisher', username: 'alisher_dev' };

  it('accepts fresh initData generated just now', () => {
    const initData = generateSignedInitData(mockUser, botToken, 0);
    const verified = verifyTelegramInitData(initData, botToken, 86400);

    expect(verified).not.toBeNull();
    expect(verified.id).toBe(mockUser.id);
    expect(verified.username).toBe(mockUser.username);
  });

  it('rejects expired initData older than maxAge (e.g. 25 hours old)', () => {
    // 25 hours ago: -90,000 seconds
    const expiredInitData = generateSignedInitData(mockUser, botToken, -90000);
    const verified = verifyTelegramInitData(expiredInitData, botToken, 86400);

    expect(verified).toBeNull();
  });

  it('rejects initData with future clock drift exceeding 60s', () => {
    const futureInitData = generateSignedInitData(mockUser, botToken, 300); // +5 minutes
    const verified = verifyTelegramInitData(futureInitData, botToken, 86400);

    expect(verified).toBeNull();
  });

  it('rejects initData if hash is tampered with', () => {
    const initData = generateSignedInitData(mockUser, botToken, 0);
    const tampered = initData.replace(/hash=[a-f0-9]+/, 'hash=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad');
    const verified = verifyTelegramInitData(tampered, botToken, 86400);

    expect(verified).toBeNull();
  });
});

describe('Security Hardening: NoSQL Injection Sanitizer', () => {
  it('strips dangerous MongoDB operator keys starting with $', () => {
    const req = {
      body: {
        username: 'valid_user',
        password: { $ne: null },
        filter: { $gt: 10, cleanKey: 'hello' },
      },
      query: {
        role: { $where: 'sleep(1000)' },
      },
      params: {},
    };

    sanitizeRequest(req, {}, () => {});

    expect(req.body.username).toBe('valid_user');
    expect(req.body.password.$ne).toBeUndefined();
    expect(req.body.filter.$gt).toBeUndefined();
    expect(req.body.filter.cleanKey).toBe('hello');
    expect(req.query.role.$where).toBeUndefined();
  });

  it('strips keys containing dot notation traversal', () => {
    const req = {
      body: {
        'profile.role': 'admin',
        normalKey: 'ok',
      },
      query: {},
      params: {},
    };

    sanitizeRequest(req, {}, () => {});

    expect(req.body['profile.role']).toBeUndefined();
    expect(req.body.normalKey).toBe('ok');
  });

  it('safely handles arrays and nested objects', () => {
    const req = {
      body: [
        { id: 1, $secret: 'leaked' },
        { id: 2, nested: { $gt: 5, value: 42 } },
      ],
      query: {},
      params: {},
    };

    sanitizeRequest(req, {}, () => {});

    expect(req.body[0].$secret).toBeUndefined();
    expect(req.body[0].id).toBe(1);
    expect(req.body[1].nested.$gt).toBeUndefined();
    expect(req.body[1].nested.value).toBe(42);
  });
});

describe('Server Optimization: In-Memory TTL Cache', () => {
  let cache;

  beforeEach(() => {
    cache = new MemoryCache(5);
  });

  it('stores and retrieves cached data before expiration', () => {
    cache.set('shop:123', { name: 'SmartChair Pro' }, 60);
    const item = cache.get('shop:123');
    expect(item).toEqual({ name: 'SmartChair Pro' });
  });

  it('returns null and purges item after TTL expires', async () => {
    cache.set('temporary', 'val', 0.05); // 50ms TTL
    expect(cache.get('temporary')).toBe('val');

    await new Promise((res) => setTimeout(res, 70));
    expect(cache.get('temporary')).toBeNull();
  });

  it('invalidates entries by key prefix', () => {
    cache.set('shop:1', { a: 1 }, 60);
    cache.set('shop:2', { b: 2 }, 60);
    cache.set('user:1', { c: 3 }, 60);

    cache.delPrefix('shop:');

    expect(cache.get('shop:1')).toBeNull();
    expect(cache.get('shop:2')).toBeNull();
    expect(cache.get('user:1')).toEqual({ c: 3 });
  });

  it('respects maxSize by evicting oldest item when full', () => {
    for (let i = 1; i <= 6; i++) {
      cache.set(`key:${i}`, i, 60);
    }
    // Size should not exceed 5
    expect(cache.size()).toBe(5);
    // Oldest key (key:1) was evicted
    expect(cache.get('key:1')).toBeNull();
    expect(cache.get('key:6')).toBe(6);
  });

  it('simpleCache helper functions work seamlessly', () => {
    setCached('test-key', { data: 123 }, 2000);
    expect(getCached('test-key')).toEqual({ data: 123 });

    delCached('test-key');
    expect(getCached('test-key')).toBeUndefined();

    setCached('shop:abc', { name: 'Shop ABC' }, 60000);
    setCached('all-shops', ['Shop ABC'], 60000);
    setCached('home-feed', { top: [] }, 60000);

    invalidateShopCache('abc');

    expect(getCached('shop:abc')).toBeUndefined();
    expect(getCached('all-shops')).toBeUndefined();
    expect(getCached('home-feed')).toBeUndefined();
  });
});
