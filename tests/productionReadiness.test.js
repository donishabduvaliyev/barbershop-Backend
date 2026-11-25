import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import { sanitizeRequest } from '../middleware/sanitize.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import adminShopRouter from '../routes/adminShop.js';
import adminCrmRouter from '../routes/adminCrm.js';
import adminStatsRouter from '../routes/adminStats.js';
import { signAdminToken } from '../middleware/adminAuth.js';
import { COLLECTIONS, stopBackupJob } from '../jobs/backup.js';
import { stopReminderJob } from '../jobs/reminders.js';
import { stopWinBackJob } from '../jobs/winBack.js';
import { stopPendingBookingSweepJob } from '../jobs/pendingBookingSweep.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let server;
let baseUrl;
let shopA;
let tokenA;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-32-characters-long!';
  await setupTestDb();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(sanitizeRequest);

  const testProxyRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests' },
  });

  app.get('/api/test-proxy-limit', testProxyRateLimiter, (req, res) => {
    res.json({ ip: req.ip });
  });

  app.use('/api/admin/shop', adminShopRouter);
  app.use('/api/admin/crm', adminCrmRouter);
  app.use('/api/admin/stats', adminStatsRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  shopA = await ServicesModel.create({
    id: 951,
    name: { en: 'Prod Ready Shop', uz: 'Prod Ready Shop', ru: 'Prod Ready Shop' },
    category: 'Barbershop',
    description: { en: 'Test', uz: 'Test', ru: 'Test' },
    image: 'https://example.com/shop.jpg',
    phone: '+998901112233',
    address: 'Tashkent',
    location: { type: 'Point', coordinates: [69.24, 41.31] },
  });
  tokenA = signAdminToken({ telegramId: 55555, shopId: shopA._id });
});

describe('Production Readiness & Security Verification (Ticket 06)', () => {
  it('enables trust proxy in server.js and isolates rate limits by X-Forwarded-For IP', async () => {
    const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
    expect(serverSource).toContain("app.set('trust proxy', 1)");

    const ip1Headers = { 'X-Forwarded-For': '203.0.113.10' };
    const ip2Headers = { 'X-Forwarded-For': '203.0.113.11' };

    const r1 = await fetch(`${baseUrl}/api/test-proxy-limit`, { headers: ip1Headers });
    const r2 = await fetch(`${baseUrl}/api/test-proxy-limit`, { headers: ip1Headers });
    const r3 = await fetch(`${baseUrl}/api/test-proxy-limit`, { headers: ip1Headers });
    const r4 = await fetch(`${baseUrl}/api/test-proxy-limit`, { headers: ip2Headers });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r4.status).toBe(200);

    const body4 = await r4.json();
    expect(body4.ip).toBe('203.0.113.11');
  });

  it('rejects image/svg+xml uploads to /api/admin/shop/photo with HTTP 400 JSON', async () => {
    const formData = new FormData();
    const svgBlob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], {
      type: 'image/svg+xml',
    });
    formData.append('photo', svgBlob, 'xss.svg');

    const res = await fetch(`${baseUrl}/api/admin/shop/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toMatch(/JPEG, PNG, WebP, HEIC, or HEIF/i);
  });

  it('includes all Salon OS collections in backup.js and exports callable stop*Job functions', () => {
    const collectionNames = COLLECTIONS.map((c) => c.name);
    expect(collectionNames).toEqual(
      expect.arrayContaining(['cashRegisters', 'transactions', 'staffShifts', 'waitlistEntries'])
    );

    expect(typeof stopBackupJob).toBe('function');
    expect(typeof stopReminderJob).toBe('function');
    expect(typeof stopWinBackJob).toBe('function');
    expect(typeof stopPendingBookingSweepJob).toBe('function');

    expect(() => {
      stopBackupJob();
      stopReminderJob();
      stopWinBackJob();
      stopPendingBookingSweepJob();
    }).not.toThrow();
  });

  it('enforces the 3-per-15-min per-shop rate limit on POST /api/admin/crm/broadcast-reengagement', async () => {
    const reqInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ targetSegment: 'at_risk', messageTemplate: 'Come back!' }),
    };

    const res1 = await fetch(`${baseUrl}/api/admin/crm/broadcast-reengagement`, reqInit);
    const res2 = await fetch(`${baseUrl}/api/admin/crm/broadcast-reengagement`, reqInit);
    const res3 = await fetch(`${baseUrl}/api/admin/crm/broadcast-reengagement`, reqInit);
    const res4 = await fetch(`${baseUrl}/api/admin/crm/broadcast-reengagement`, reqInit);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);
    expect(res4.status).toBe(429);
  });

  it('groups completed bookings in Asia/Tashkent timezone in GET /api/admin/stats/overview', async () => {
    // 2026-11-21T21:00:00.000Z === 2026-11-22 02:00:00 Asia/Tashkent (UTC+5)
    await Booking.create({
      shopId: shopA._id,
      shopName: 'Prod Ready Shop',
      userTelegramId: 88888,
      userName: 'Test Client',
      userNumber: '+998901234567',
      requestedTime: new Date('2026-11-21T21:00:00.000Z'),
      status: 'completed',
      price: 50000,
    });

    const res = await fetch(
      `${baseUrl}/api/admin/stats/overview?from=2026-11-21T00:00:00.000Z&to=2026-11-23T00:00:00.000Z`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revenueOverTime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026-11-22', revenue: 50000, appointments: 1 }),
      ])
    );
    expect(data.revenueOverTime.find((d) => d.date === '2026-11-21')).toBeUndefined();
  });
});
