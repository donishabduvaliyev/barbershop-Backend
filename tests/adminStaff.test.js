import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import StaffShift from '../models/staffShift.js';
import adminStaffRouter from '../routes/adminStaff.js';
import { signAdminToken } from '../middleware/adminAuth.js';

let server;
let baseUrl;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-32-characters-long!';
  await setupTestDb();

  const app = express();
  app.use(express.json());
  app.use('/api/admin/staff', adminStaffRouter);

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

describe('Staff Shifts & Commissions Module', () => {
  it('manages staff shifts lifecycle (schedule, clock-in, clock-out, delete)', async () => {
    // 1. Create a shop with staff
    const staffId = new mongoose.Types.ObjectId();
    const shop = await ServicesModel.create({
      id: 101,
      name: { en: 'Grand Salon', uz: 'Grand Salon', ru: 'Гранд Салон' },
      category: 'Barbershop',
      description: { en: 'Top', uz: 'Top', ru: 'Топ' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi st 1',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      services: [{ name: { en: 'Cut', uz: 'Soch', ru: 'Стрижка' }, price: 80000, durationMinutes: 30 }],
      workingHours: [{ days: ['Monday', 'Tuesday'], from: '09:00', to: '20:00' }],
      staff: [{ _id: staffId, name: 'Aziz Barber', commission: 40 }],
    });

    const token = signAdminToken({ telegramId: 99999, shopId: shop._id });

    // 2. Schedule shift
    const createRes = await fetch(`${baseUrl}/api/admin/staff/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        staffId: staffId.toString(),
        date: '2026-11-25',
        notes: 'Morning shift',
      }),
    });

    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    expect(createData.shift.status).toBe('scheduled');
    const shiftId = createData.shift._id;

    // 3. Prevent duplicate shift on same date for same staff
    const dupRes = await fetch(`${baseUrl}/api/admin/staff/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        staffId: staffId.toString(),
        date: '2026-11-25',
      }),
    });
    // Upserts cleanly without error
    expect(dupRes.status).toBe(201);

    // 4. Clock-in
    const inRes = await fetch(`${baseUrl}/api/admin/staff/shifts/${shiftId}/clock-in`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inRes.status).toBe(200);
    const inData = await inRes.json();
    expect(inData.shift.status).toBe('active');
    expect(inData.shift.clockIn).toBeTruthy();

    // 5. Clock-out
    const outRes = await fetch(`${baseUrl}/api/admin/staff/shifts/${shiftId}/clock-out`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(outRes.status).toBe(200);
    const outData = await outRes.json();
    expect(outData.shift.status).toBe('completed');
    expect(outData.shift.clockOut).toBeTruthy();

    // 6. List shifts
    const listRes = await fetch(`${baseUrl}/api/admin/staff/shifts?date=2026-11-25`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.shifts).toHaveLength(1);
    expect(listData.shifts[0].notes).toBe('Morning shift');

    // 7. Delete shift
    const delRes = await fetch(`${baseUrl}/api/admin/staff/shifts/${shiftId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status).toBe(200);
  });

  it('calculates commissions and payroll accurately', async () => {
    const staff1 = new mongoose.Types.ObjectId();
    const staff2 = new mongoose.Types.ObjectId();

    const shop = await ServicesModel.create({
      id: 102,
      name: { en: 'Luxe Salon', uz: 'Luxe Salon', ru: 'Люкс Салон' },
      category: 'Barbershop',
      description: { en: 'Top', uz: 'Top', ru: 'Топ' },
      image: 'https://example.com/img.jpg',
      phone: '+998901112233',
      address: 'Navoi st 1',
      location: { type: 'Point', coordinates: [69.24, 41.31] },
      services: [{ name: { en: 'Cut', uz: 'Soch', ru: 'Стрижка' }, price: 100000, durationMinutes: 30 }],
      workingHours: [{ days: ['Monday'], from: '09:00', to: '20:00' }],
      staff: [
        { _id: staff1, name: 'Sardor', commission: 60 },
        { _id: staff2, name: 'Bekzod', commission: 40 },
      ],
    });

    const token = signAdminToken({ telegramId: 99999, shopId: shop._id });

    // Completed bookings:
    // Sardor: 2 bookings @ 100,000 UZS = 200,000 (60% cut = 120,000 staff, 80,000 shop)
    // Bekzod: 1 booking @ 150,000 UZS = 150,000 (40% cut = 60,000 staff, 90,000 shop)
    // House unassigned: 1 booking @ 50,000 UZS (0% cut = 0 staff, 50,000 shop)
    await Booking.create([
      {
        shopId: shop._id,
        shopName: 'Luxe Salon',
        userTelegramId: 101,
        userNumber: '+998901111111',
        requestedTime: new Date('2026-11-20T10:00:00.000Z'),
        status: 'completed',
        staffId: staff1,
        staffName: 'Sardor',
        price: 100000,
      },
      {
        shopId: shop._id,
        shopName: 'Luxe Salon',
        userTelegramId: 102,
        userNumber: '+998902222222',
        requestedTime: new Date('2026-11-20T12:00:00.000Z'),
        status: 'completed',
        staffId: staff1,
        staffName: 'Sardor',
        price: 100000,
      },
      {
        shopId: shop._id,
        shopName: 'Luxe Salon',
        userTelegramId: 103,
        userNumber: '+998903333333',
        requestedTime: new Date('2026-11-20T14:00:00.000Z'),
        status: 'completed',
        staffId: staff2,
        staffName: 'Bekzod',
        price: 150000,
      },
      {
        shopId: shop._id,
        shopName: 'Luxe Salon',
        userTelegramId: 104,
        userNumber: '+998904444444',
        requestedTime: new Date('2026-11-20T16:00:00.000Z'),
        status: 'completed',
        staffId: null,
        staffName: '',
        price: 50000,
      },
    ]);

    const res = await fetch(`${baseUrl}/api/admin/staff/commissions?from=2026-11-19&to=2026-11-21`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.totalGrossRevenue).toBe(400000);
    // Total staff payouts: 120,000 + 60,000 = 180,000
    expect(data.totalStaffPayout).toBe(180000);
    // Total shop retained: 400,000 - 180,000 = 220,000
    expect(data.totalShopRetained).toBe(220000);

    const sardor = data.staffBreakdown.find((s) => s.name === 'Sardor');
    expect(sardor.grossRevenue).toBe(200000);
    expect(sardor.staffPayout).toBe(120000);
    expect(sardor.shopRetained).toBe(80000);
    expect(sardor.completedBookingsCount).toBe(2);

    const bekzod = data.staffBreakdown.find((s) => s.name === 'Bekzod');
    expect(bekzod.grossRevenue).toBe(150000);
    expect(bekzod.staffPayout).toBe(60000);
    expect(bekzod.shopRetained).toBe(90000);
    expect(bekzod.completedBookingsCount).toBe(1);
  });
});
