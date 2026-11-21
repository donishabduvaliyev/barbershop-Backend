import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import adminRegisterRouter from '../routes/adminRegister.js';
import { signAdminToken } from '../middleware/adminAuth.js';

let server;
let baseUrl;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-32-characters-long!';
  await setupTestDb();

  const app = express();
  app.use(express.json());
  app.use('/api/admin/register', adminRegisterRouter);

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

describe('Daily Cashier Register & Z-Report Module', () => {
  it('handles full register lifecycle: open, record payments/expenses, reconcile, and close Z-Report', async () => {
    const shop = await ServicesModel.create({
      id: 201,
      name: { en: 'Cashier Salon', uz: 'Cashier Salon', ru: 'Касса Салон' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Amir Temur 1',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      services: [],
      workingHours: [],
    });

    const token = signAdminToken({ telegramId: 88888, shopId: shop._id });

    // 1. Check current register (not open)
    const initRes = await fetch(`${baseUrl}/api/admin/register/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(initRes.status).toBe(200);
    const initData = await initRes.json();
    expect(initData.isOpen).toBe(false);

    // 2. Open register with 100,000 UZS float
    const openRes = await fetch(`${baseUrl}/api/admin/register/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ openingCashBalance: 100000 }),
    });
    expect(openRes.status).toBe(201);

    // 3. Cannot open a second register while one is already open
    const dupRes = await fetch(`${baseUrl}/api/admin/register/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ openingCashBalance: 50000 }),
    });
    expect(dupRes.status).toBe(409);

    // 4. Record transactions:
    // - 100,000 cash service
    // - 150,000 click service
    // - 80,000 payme service
    // - 30,000 cash expense (coffee/water)
    const txs = [
      { type: 'service_payment', amount: 100000, paymentMethod: 'cash', description: 'Haircut' },
      { type: 'service_payment', amount: 150000, paymentMethod: 'click', description: 'Beard + Cut' },
      { type: 'product_sale', amount: 80000, paymentMethod: 'payme', description: 'Pomade' },
      { type: 'expense', amount: 30000, paymentMethod: 'cash', description: 'Bottled water for clients' },
    ];

    for (const tx of txs) {
      const txRes = await fetch(`${baseUrl}/api/admin/register/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(tx),
      });
      expect(txRes.status).toBe(201);
    }

    // 5. Check live summary
    const liveRes = await fetch(`${baseUrl}/api/admin/register/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(liveRes.status).toBe(200);
    const liveData = await liveRes.json();
    expect(liveData.isOpen).toBe(true);
    expect(liveData.summary.totalIncome).toBe(330000);
    expect(liveData.summary.totalExpense).toBe(30000);
    expect(liveData.summary.netRevenue).toBe(300000);
    // Expected cash = 100,000 (float) + 100,000 (cash in) - 30,000 (cash out) = 170,000
    expect(liveData.summary.expectedCashBalance).toBe(170000);

    // 6. Close register with actual count of 165,000 UZS (5,000 UZS short)
    const closeRes = await fetch(`${baseUrl}/api/admin/register/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        closingCashBalance: 165000,
        notes: '5k short on change',
      }),
    });
    expect(closeRes.status).toBe(200);
    const closeData = await closeRes.json();
    expect(closeData.zReport.status).toBe('closed');
    expect(closeData.zReport.expectedCashBalance).toBe(170000);
    expect(closeData.zReport.closingCashBalance).toBe(165000);
    expect(closeData.zReport.cashDiscrepancy).toBe(-5000);

    // 7. Verify history
    const histRes = await fetch(`${baseUrl}/api/admin/register/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(histRes.status).toBe(200);
    const histData = await histRes.json();
    expect(histData.sessions).toHaveLength(1);
    expect(histData.sessions[0].notes).toBe('5k short on change');
  });
});
