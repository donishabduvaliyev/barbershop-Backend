import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import adminCrmRouter from '../routes/adminCrm.js';
import { signAdminToken } from '../middleware/adminAuth.js';

let server;
let baseUrl;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-32-characters-long!';
  await setupTestDb();

  const app = express();
  app.use(express.json());
  app.use('/api/admin/crm', adminCrmRouter);

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
});

describe('360° Customer CRM & RFM Segmentation Module', () => {
  it('segments customers accurately into VIP, Regular, New, At-Risk, and Lost', async () => {
    const shop = await ServicesModel.create({
      id: 401,
      name: { en: 'CRM Barbershop', uz: 'CRM Barbershop', ru: 'CRM Барбер' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi 5',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      services: [],
      workingHours: [],
    });

    const token = signAdminToken({ telegramId: 66666, shopId: shop._id });

    const now = new Date();
    const daysAgo = (d) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    // 1. VIP Client (LTV >= 1,000,000, visited 5 days ago)
    await Booking.create([
      {
        shopId: shop._id,
        shopName: 'CRM Barbershop',
        userTelegramId: 1001,
        userName: 'Alisher VIP',
        userNumber: '+998901111111',
        requestedTime: daysAgo(5),
        status: 'completed',
        price: 1200000,
      },
    ]);

    // 2. Regular Client (3 visits, last visit 10 days ago)
    await Booking.create([
      {
        shopId: shop._id,
        shopName: 'CRM Barbershop',
        userTelegramId: 1002,
        userName: 'Bekzod Regular',
        userNumber: '+998902222222',
        requestedTime: daysAgo(40),
        status: 'completed',
        price: 100000,
      },
      {
        shopId: shop._id,
        shopName: 'CRM Barbershop',
        userTelegramId: 1002,
        userName: 'Bekzod Regular',
        userNumber: '+998902222222',
        requestedTime: daysAgo(25),
        status: 'completed',
        price: 100000,
      },
      {
        shopId: shop._id,
        shopName: 'CRM Barbershop',
        userTelegramId: 1002,
        userName: 'Bekzod Regular',
        userNumber: '+998902222222',
        requestedTime: daysAgo(10),
        status: 'completed',
        price: 100000,
      },
    ]);

    // 3. At-Risk Client (last visit 35 days ago)
    await Booking.create([
      {
        shopId: shop._id,
        shopName: 'CRM Barbershop',
        userTelegramId: 1003,
        userName: 'Sanjar AtRisk',
        userNumber: '+998903333333',
        requestedTime: daysAgo(35),
        status: 'completed',
        price: 80000,
      },
    ]);

    // 4. Lost Client (last visit 75 days ago)
    await Booking.create([
      {
        shopId: shop._id,
        shopName: 'CRM Barbershop',
        userTelegramId: 1004,
        userName: 'Otabek Lost',
        userNumber: '+998904444444',
        requestedTime: daysAgo(75),
        status: 'completed',
        price: 80000,
      },
    ]);

    const res = await fetch(`${baseUrl}/api/admin/crm/segments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.totalClients).toBe(4);
    expect(data.segments.vip.count).toBe(1);
    expect(data.segments.vip.totalLtv).toBe(1200000);
    expect(data.segments.regular.count).toBe(1);
    expect(data.segments.at_risk.count).toBe(1);
    expect(data.segments.lost.count).toBe(1);

    const riskRes = await fetch(`${baseUrl}/api/admin/crm/at-risk`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(riskRes.status).toBe(200);
    const riskData = await riskRes.json();
    expect(riskData.atRiskClients).toHaveLength(1);
    expect(riskData.atRiskClients[0].name).toBe('Sanjar AtRisk');
  });
});
