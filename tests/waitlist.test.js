import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { calculateStaffPayroll } from '../services/staffPayrollService.js';
import adminWaitlistRouter from '../routes/adminWaitlist.js';
import shopRoutes from '../routes/shops.js';
import { signAdminToken } from '../middleware/adminAuth.js';

let server;
let baseUrl;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-32-characters-long!';
  await setupTestDb();

  const app = express();
  app.use(express.json());
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

describe('Live Walk-In Waitlist & Digital Queue Module', () => {
  it('supports sequential queueing, public position check, call, seat, and complete', async () => {
    const barberId = new mongoose.Types.ObjectId();
    const shop = await ServicesModel.create({
      id: 301,
      name: { en: 'Queue Barbershop', uz: 'Queue Barbershop', ru: 'Очередь Барбер' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi 10',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      services: [],
      workingHours: [],
      staff: [{ _id: barberId, name: 'Kamol' }],
    });

    const token = signAdminToken({ telegramId: 77777, shopId: shop._id });

    // 1. Public customer #1 checks in via QR
    const join1 = await fetch(`${baseUrl}/api/shops/${shop._id}/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Dilshod',
        customerPhone: '+998901234567',
        staffId: barberId.toString(),
        serviceName: 'Haircut',
      }),
    });
    expect(join1.status).toBe(201);
    const data1 = await join1.json();
    expect(data1.entry.queueNumber).toBe(1);
    expect(data1.positionAhead).toBe(0);

    // 2. Receptionist adds walk-in customer #2
    const join2 = await fetch(`${baseUrl}/api/admin/waitlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        customerName: 'Javohir',
        customerPhone: '+998909876543',
        serviceName: 'Beard Trim',
      }),
    });
    expect(join2.status).toBe(201);
    const data2 = await join2.json();
    expect(data2.entry.queueNumber).toBe(2);

    // 3. Customer #2 checks live position ahead
    const posRes = await fetch(`${baseUrl}/api/shops/${shop._id}/waitlist/${data2.entry._id}`);
    expect(posRes.status).toBe(200);
    const posData = await posRes.json();
    expect(posData.positionAhead).toBe(1);

    // 4. Call customer #1
    const callRes = await fetch(`${baseUrl}/api/admin/waitlist/${data1.entry._id}/call`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(callRes.status).toBe(200);
    const callData = await callRes.json();
    expect(callData.entry.status).toBe('called');
    expect(callData.entry.calledAt).toBeTruthy();

    // 5. Seat customer #1 in chair
    const seatRes = await fetch(`${baseUrl}/api/admin/waitlist/${data1.entry._id}/seat`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(seatRes.status).toBe(200);
    const seatData = await seatRes.json();
    expect(seatData.entry.status).toBe('in_chair');

    // 6. Complete customer #1
    const compRes = await fetch(`${baseUrl}/api/admin/waitlist/${data1.entry._id}/complete`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(compRes.status).toBe(200);
    const compData = await compRes.json();
    expect(compData.entry.status).toBe('completed');

    // 7. Admin gets active queue (only customer #2 should remain waiting)
    const listRes = await fetch(`${baseUrl}/api/admin/waitlist`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.queue).toHaveLength(1);
    expect(listData.queue[0].customerName).toBe('Javohir');
  });

  it('unifies walk-in queue with scheduled bookings, wait estimates, and staff payroll', async () => {
    const barberId = new mongoose.Types.ObjectId();
    const serviceId = new mongoose.Types.ObjectId();
    const shop = await ServicesModel.create({
      id: 302,
      name: { en: 'Unified Salon', uz: 'Unified Salon', ru: 'Единый Салон' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi 10',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      services: [{ _id: serviceId, name: { en: 'Fade', uz: 'Fade', ru: 'Фейд' }, price: 100000, durationMinutes: 45 }],
      workingHours: [{ days: ['Monday', 'Sunday'], from: '09:00', to: '22:00' }],
      staff: [{ _id: barberId, name: 'Aziz', commission: 50 }],
    });

    const token = signAdminToken({ telegramId: 77777, shopId: shop._id });

    // Create 2 scheduled bookings in the next 2 hours
    const nextHour = new Date(Date.now() + 30 * 60 * 1000);
    const secondHour = new Date(Date.now() + 90 * 60 * 1000);
    await Booking.create([
      {
        shopId: shop._id,
        shopName: 'Unified Salon',
        userTelegramId: 5001,
        userNumber: '+998901110001',
        requestedTime: nextHour,
        status: 'confirmed',
        staffId: barberId,
      },
      {
        shopId: shop._id,
        shopName: 'Unified Salon',
        userTelegramId: 5002,
        userNumber: '+998901110002',
        requestedTime: secondHour,
        status: 'pending',
        staffId: barberId,
      },
    ]);

    // 1. Public summary should reflect the 2 scheduled bookings in wait estimate
    const sumRes = await fetch(`${baseUrl}/api/shops/${shop._id}/waitlist/summary`);
    expect(sumRes.status).toBe(200);
    const sumData = await sumRes.json();
    expect(sumData.upcomingBookingsCount).toBe(2);
    expect(sumData.estimatedWaitMinutes).toBeGreaterThanOrEqual(50);

    // 2. Join waitlist with serviceId -> price & serviceName auto-resolved
    const joinRes = await fetch(`${baseUrl}/api/shops/${shop._id}/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'WalkIn Client',
        customerPhone: '+998905556677',
        staffId: barberId.toString(),
        serviceId: serviceId.toString(),
      }),
    });
    expect(joinRes.status).toBe(201);
    const joinData = await joinRes.json();
    expect(joinData.entry.price).toBe(100000);

    // 3. Seat & complete walk-in -> creates Booking (source: 'walk-in', status: 'completed')
    await fetch(`${baseUrl}/api/admin/waitlist/${joinData.entry._id}/seat`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    const compRes = await fetch(`${baseUrl}/api/admin/waitlist/${joinData.entry._id}/complete`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(compRes.status).toBe(200);
    const compData = await compRes.json();
    expect(compData.entry.bookingId).toBeTruthy();

    // Verify synced Booking exists in BookingData
    const syncedBooking = await Booking.findById(compData.entry.bookingId);
    expect(syncedBooking).toBeTruthy();
    expect(syncedBooking.source).toBe('walk-in');
    expect(syncedBooking.status).toBe('completed');
    expect(syncedBooking.price).toBe(100000);

    // 4. Verify Staff Payroll includes the completed walk-in revenue & commission!
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date();
    dayEnd.setHours(23, 59, 59, 999);
    const payroll = await calculateStaffPayroll(shop._id, dayStart, dayEnd);
    expect(payroll.totalGrossRevenue).toBe(100000);
    expect(payroll.totalStaffPayout).toBe(50000);
  });
});
