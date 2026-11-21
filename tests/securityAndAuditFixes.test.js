import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Customer from '../models/customer.js';
import StaffShift from '../models/staffShift.js';
import Transaction from '../models/transaction.js';
import adminRegisterRouter from '../routes/adminRegister.js';
import adminAppointmentsRouter from '../routes/adminAppointments.js';
import adminStaffRouter from '../routes/adminStaff.js';
import adminWaitlistRouter from '../routes/adminWaitlist.js';
import shopRoutes from '../routes/shops.js';
import { signAdminToken } from '../middleware/adminAuth.js';
import { calculateStaffPayroll } from '../services/staffPayrollService.js';

let server;
let baseUrl;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-32-characters-long!';
  await setupTestDb();

  const app = express();
  app.use(express.json());
  app.use('/api/admin/register', adminRegisterRouter);
  app.use('/api/admin/appointments', adminAppointmentsRouter);
  app.use('/api/admin/staff', adminStaffRouter);
  app.use('/api/admin/waitlist', adminWaitlistRouter);
  app.use('/api/shops', shopRoutes);

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

describe('20-Point Audit Regression & Integrity Suite', () => {
  it('blocks concurrent split-payment race condition and enforces paid-booking cancel lock + refund unlock', async () => {
    const barberId = new mongoose.Types.ObjectId();
    const shop = await ServicesModel.create({
      id: 701,
      name: { en: 'Audit Salon', uz: 'Audit Salon', ru: 'Аудит Салон' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi 1',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      staff: [{ _id: barberId, name: 'Aziz', commission: 50 }],
    });
    const token = signAdminToken({ telegramId: 11111, shopId: shop._id });

    await fetch(`${baseUrl}/api/admin/register/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ openingCashBalance: 0 }),
    });

    const booking = await Booking.create({
      shopId: shop._id,
      shopName: 'Audit Salon',
      userTelegramId: 8001,
      userName: 'Race Client',
      userNumber: '+998901234567',
      requestedTime: new Date(),
      status: 'confirmed',
      staffId: barberId,
      staffName: 'Aziz',
      price: 100000,
    });

    // 1. Concurrent 60,000 + 60,000 payments on a 100,000 booking -> only 1 succeeds!
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/admin/register/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'service_payment', amount: 60000, paymentMethod: 'cash', bookingId: booking._id }),
      }),
      fetch(`${baseUrl}/api/admin/register/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'service_payment', amount: 60000, paymentMethod: 'click', bookingId: booking._id }),
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(201);
    expect([400, 409]).toContain(statuses[1]);

    const txs = await Transaction.find({ bookingId: booking._id });
    expect(txs).toHaveLength(1);
    const updated = await Booking.findById(booking._id);
    expect(updated.paidAmount).toBe(60000);

    // 2. Paid booking cannot be cancelled or marked no-show until refunded (409)
    const cancelBlocked = await fetch(`${baseUrl}/api/admin/appointments/${booking._id}/cancel`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: 'Changed mind' }),
    });
    expect(cancelBlocked.status).toBe(409);

    // 3. Record payout refund of 60,000 -> unlocks booking for cancellation
    const refundRes = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'payout', amount: 60000, paymentMethod: 'cash', bookingId: booking._id, description: 'Refund' }),
    });
    expect(refundRes.status).toBe(201);

    const cancelOk = await fetch(`${baseUrl}/api/admin/appointments/${booking._id}/cancel`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: 'Refunded' }),
    });
    expect(cancelOk.status).toBe(200);
  });

  it('backfills Booking.price on priceless bookings and preserves staffId across same-hour walk-ins', async () => {
    const barberId = new mongoose.Types.ObjectId();
    const shop = await ServicesModel.create({
      id: 702,
      name: { en: 'Walkin Salon', uz: 'Walkin Salon', ru: 'Салон' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi 2',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      staff: [{ _id: barberId, name: 'Jasur', commission: 40 }],
    });
    const token = signAdminToken({ telegramId: 22222, shopId: shop._id });

    await fetch(`${baseUrl}/api/admin/register/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ openingCashBalance: 0 }),
    });

    // Two walk-ins for the same barber in the same hour (both priceless initially)
    const w1 = await (await fetch(`${baseUrl}/api/admin/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ customerName: 'Guest 1', customerPhone: '+998901110001', staffId: barberId }),
    })).json();

    const w2 = await (await fetch(`${baseUrl}/api/admin/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ customerName: 'Guest 2', customerPhone: '+998901110002', staffId: barberId }),
    })).json();

    // Seat & complete both
    await fetch(`${baseUrl}/api/admin/waitlist/${w1.entry._id}/seat`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
    const c1 = await (await fetch(`${baseUrl}/api/admin/waitlist/${w1.entry._id}/complete`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } })).json();

    await fetch(`${baseUrl}/api/admin/waitlist/${w2.entry._id}/seat`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
    const c2 = await (await fetch(`${baseUrl}/api/admin/waitlist/${w2.entry._id}/complete`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } })).json();

    const b1 = await Booking.findById(c1.entry.bookingId);
    const b2 = await Booking.findById(c2.entry.bookingId);
    expect(String(b1.staffId)).toBe(String(barberId));
    expect(String(b2.staffId)).toBe(String(barberId));

    // Pay 85,000 for priceless walk-in #1 -> backfills Booking.price = 85000
    await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'service_payment', amount: 85000, paymentMethod: 'cash', bookingId: b1._id }),
    });

    const refreshedB1 = await Booking.findById(b1._id);
    expect(refreshedB1.price).toBe(85000);
    expect(refreshedB1.isPaid).toBe(true);

    // Payroll includes 85,000 at Jasur's snapshotted 40% commission = 34,000
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const payroll = await calculateStaffPayroll(shop._id, start, end);
    expect(payroll.totalGrossRevenue).toBe(85000);
    expect(payroll.totalStaffPayout).toBe(34000);
  });

  it('normalizes phone numbers for idempotent waitlist join, blocks banned clients, and isolates single-day payroll shifts', async () => {
    const barberId = new mongoose.Types.ObjectId();
    const shop = await ServicesModel.create({
      id: 703,
      name: { en: 'Norm Salon', uz: 'Norm Salon', ru: 'Норм Салон' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi 3',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      staff: [{ _id: barberId, name: 'Sardor', commission: 40 }],
    });
    const token = signAdminToken({ telegramId: 33333, shopId: shop._id });

    // 1. Phone normalization idempotency
    const j1 = await (await fetch(`${baseUrl}/api/shops/${shop._id}/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'Ali', customerPhone: '+998 90 555-44-33' }),
    })).json();
    const j2 = await (await fetch(`${baseUrl}/api/shops/${shop._id}/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'Ali', customerPhone: '905554433' }),
    })).json();
    expect(j2.alreadyInQueue).toBe(true);
    expect(j2.entry._id).toBe(j1.entry._id);

    // 2. Blocked customer cannot join waitlist (403)
    await Customer.create({
      shopId: shop._id,
      telegramId: -99999,
      name: 'Banned Guy',
      number: '+998907771122',
      isBlocked: true,
    });
    const banRes = await fetch(`${baseUrl}/api/shops/${shop._id}/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'Banned Guy', customerPhone: '907771122' }),
    });
    expect(banRes.status).toBe(403);

    // 3. Single-day payroll (?date=2026-11-21) must NOT include 2026-11-22 shifts
    await StaffShift.create([
      { shopId: shop._id, staffId: barberId, date: '2026-11-21', status: 'completed' },
      { shopId: shop._id, staffId: barberId, date: '2026-11-22', status: 'completed' },
    ]);
    const payRes = await (await fetch(`${baseUrl}/api/admin/staff/commissions?date=2026-11-21`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    expect(payRes.staffBreakdown[0].shiftsCount).toBe(1);
  });
});
