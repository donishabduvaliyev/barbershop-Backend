import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
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

  it('supports split payments up to service price and blocks overpayments, duplicates, 0-amount, and cancelled bookings', async () => {
    const shop = await ServicesModel.create({
      id: 202,
      name: { en: 'Split Salon', uz: 'Split Salon', ru: 'Сплит Салон' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Amir Temur 2',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      services: [],
      workingHours: [],
    });

    const token = signAdminToken({ telegramId: 88888, shopId: shop._id });

    await fetch(`${baseUrl}/api/admin/register/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ openingCashBalance: 0 }),
    });

    const booking = await Booking.create({
      shopId: shop._id,
      shopName: 'Split Salon',
      userTelegramId: 7001,
      userName: 'Split Client',
      userNumber: '+998901234567',
      requestedTime: new Date(),
      status: 'completed',
      price: 100000,
    });

    const cancelledBooking = await Booking.create({
      shopId: shop._id,
      shopName: 'Split Salon',
      userTelegramId: 7002,
      userName: 'Cancelled Client',
      userNumber: '+998907654321',
      requestedTime: new Date(Date.now() + 3600000),
      status: 'cancelled',
      price: 100000,
    });

    // 1. Reject 0 amount
    const zeroRes = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'service_payment', amount: 0, bookingId: booking._id }),
    });
    expect(zeroRes.status).toBe(400);

    // 2. Reject payment on cancelled booking
    const cancelRes = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'service_payment', amount: 50000, bookingId: cancelledBooking._id }),
    });
    expect(cancelRes.status).toBe(400);

    // 3. First split payment: 60,000 Cash
    const p1 = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'service_payment', amount: 60000, paymentMethod: 'cash', bookingId: booking._id }),
    });
    expect(p1.status).toBe(201);
    let updatedBooking = await Booking.findById(booking._id);
    expect(updatedBooking.paidAmount).toBe(60000);
    expect(updatedBooking.isPaid).toBe(false);
    expect(updatedBooking.paymentMethod).toBe('cash');

    // 4. Reject overpayment (50,000 > 40,000 remaining)
    const overRes = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'service_payment', amount: 50000, paymentMethod: 'click', bookingId: booking._id }),
    });
    expect(overRes.status).toBe(400);

    // 5. Second split payment: 40,000 Click -> completes payment!
    const p2 = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'service_payment', amount: 40000, paymentMethod: 'click', bookingId: booking._id }),
    });
    expect(p2.status).toBe(201);
    updatedBooking = await Booking.findById(booking._id);
    expect(updatedBooking.paidAmount).toBe(100000);
    expect(updatedBooking.isPaid).toBe(true);
    expect(updatedBooking.paymentMethod).toBe('split');

    // 6. Reject any further service_payment once isPaid is true -> 409 Conflict
    const dupRes = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'service_payment', amount: 10000, paymentMethod: 'cash', bookingId: booking._id }),
    });
    expect(dupRes.status).toBe(409);
  });
});
