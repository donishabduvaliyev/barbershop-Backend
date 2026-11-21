import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import { sanitizeRequest } from '../middleware/sanitize.js';
import ServicesModel from '../models/shopData.js';
import adminStaffRouter from '../routes/adminStaff.js';
import adminRegisterRouter from '../routes/adminRegister.js';
import adminWaitlistRouter from '../routes/adminWaitlist.js';
import adminCrmRouter from '../routes/adminCrm.js';
import shopRoutes from '../routes/shops.js';
import { signAdminToken } from '../middleware/adminAuth.js';

let server;
let baseUrl;
let shopA;
let shopB;
let staffA;
let staffB;
let tokenA;
let tokenB;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-32-characters-long!';
  await setupTestDb();

  const app = express();
  app.use(express.json());
  app.use(sanitizeRequest);
  app.use('/api/admin/staff', adminStaffRouter);
  app.use('/api/admin/register', adminRegisterRouter);
  app.use('/api/admin/waitlist', adminWaitlistRouter);
  app.use('/api/admin/crm', adminCrmRouter);
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
  staffA = new mongoose.Types.ObjectId();
  staffB = new mongoose.Types.ObjectId();

  shopA = await ServicesModel.create({
    id: 901,
    name: { en: 'Shop A', uz: 'Shop A', ru: 'Магазин А' },
    category: 'Barbershop',
    description: { en: 'A', uz: 'A', ru: 'A' },
    image: 'https://example.com/a.jpg',
    phone: '+998901111111',
    address: 'Street A',
    location: { type: 'Point', coordinates: [69.24, 41.31] },
    staff: [{ _id: staffA, name: 'Barber A', commission: 50 }],
  });

  shopB = await ServicesModel.create({
    id: 902,
    name: { en: 'Shop B', uz: 'Shop B', ru: 'Магазин Б' },
    category: 'Barbershop',
    description: { en: 'B', uz: 'B', ru: 'B' },
    image: 'https://example.com/b.jpg',
    phone: '+998902222222',
    address: 'Street B',
    location: { type: 'Point', coordinates: [69.25, 41.32] },
    staff: [{ _id: staffB, name: 'Barber B', commission: 50 }],
  });

  tokenA = signAdminToken({ telegramId: 11111, shopId: shopA._id });
  tokenB = signAdminToken({ telegramId: 22222, shopId: shopB._id });
});

describe('Security Audit & Penetration Tests (Stage 2 Salon OS)', () => {
  it('blocks unauthenticated access to all admin OS endpoints with 401', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/admin/staff/shifts' },
      { method: 'GET', path: '/api/admin/staff/commissions' },
      { method: 'GET', path: '/api/admin/register/current' },
      { method: 'POST', path: '/api/admin/register/open' },
      { method: 'GET', path: '/api/admin/waitlist' },
      { method: 'GET', path: '/api/admin/crm/segments' },
      { method: 'POST', path: '/api/admin/crm/broadcast-reengagement' },
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, { method: ep.method });
      expect(res.status).toBe(401);
    }
  });

  it('prevents cross-shop IDOR attacks across shifts, waitlist, and staff', async () => {
    // Shop B creates a shift and a waitlist entry
    const shiftBRes = await fetch(`${baseUrl}/api/admin/staff/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ staffId: staffB.toString(), date: '2026-11-22' }),
    });
    const shiftB = (await shiftBRes.json()).shift;

    const waitBRes = await fetch(`${baseUrl}/api/admin/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ customerName: 'Victim Client', customerPhone: '+998909999999' }),
    });
    const waitB = (await waitBRes.json()).entry;

    // Shop A tries to clock-in Shop B's shift -> 404
    const idorShift = await fetch(`${baseUrl}/api/admin/staff/shifts/${shiftB._id}/clock-in`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(idorShift.status).toBe(404);

    // Shop A tries to assign Shop B's staff -> 404
    const idorAssign = await fetch(`${baseUrl}/api/admin/staff/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ staffId: staffB.toString(), date: '2026-11-22' }),
    });
    expect(idorAssign.status).toBe(404);

    // Shop A tries to call Shop B's waitlist customer -> 404
    const idorWait = await fetch(`${baseUrl}/api/admin/waitlist/${waitB._id}/call`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(idorWait.status).toBe(404);
  });

  it('rejects malformed ObjectIds and invalid dates with 400 instead of 500 CastError', async () => {
    const badIds = ['not-an-id', '../../../etc/passwd', '12345'];

    for (const badId of badIds) {
      const r1 = await fetch(`${baseUrl}/api/admin/staff/shifts/${encodeURIComponent(badId)}/clock-in`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(r1.status).toBe(400);

      const r2 = await fetch(`${baseUrl}/api/admin/register/transactions?registerId=${encodeURIComponent(badId)}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(r2.status).toBe(400);

      const r3 = await fetch(`${baseUrl}/api/admin/waitlist/${encodeURIComponent(badId)}/call`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(r3.status).toBe(400);

      const r4 = await fetch(`${baseUrl}/api/shops/${encodeURIComponent(badId)}/waitlist/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerName: 'Test', customerPhone: '+998901234567' }),
      });
      expect(r4.status).toBe(400);
    }

    // Invalid dates
    const badDateRes = await fetch(`${baseUrl}/api/admin/staff/shifts?date=2026-99-99`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(badDateRes.status).toBe(400);

    const badCommRes = await fetch(`${baseUrl}/api/admin/staff/commissions?from=2026-12-10&to=2026-12-01`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(badCommRes.status).toBe(400);
  });

  it('blocks financial tampering (negative amounts, NaN, invalid types) and invalid state transitions', async () => {
    // Negative opening cash
    const negOpen = await fetch(`${baseUrl}/api/admin/register/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ openingCashBalance: -50000 }),
    });
    expect(negOpen.status).toBe(400);

    // Valid open
    await fetch(`${baseUrl}/api/admin/register/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ openingCashBalance: 100000 }),
    });

    // Negative transaction amount & invalid type
    const negTx = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ type: 'service_payment', amount: -10000, paymentMethod: 'cash' }),
    });
    expect(negTx.status).toBe(400);

    const badTypeTx = await fetch(`${baseUrl}/api/admin/register/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ type: 'hack_money', amount: 50000 }),
    });
    expect(badTypeTx.status).toBe(400);

    // Invalid closing cash (empty string / negative)
    const badClose = await fetch(`${baseUrl}/api/admin/register/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ closingCashBalance: '' }),
    });
    expect(badClose.status).toBe(400);

    // Out-of-bounds commission
    const badComm = await fetch(`${baseUrl}/api/admin/staff/${staffA}/commission`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ commission: 150 }),
    });
    expect(badComm.status).toBe(400);

    // Shift clock-out before clock-in
    const shRes = await fetch(`${baseUrl}/api/admin/staff/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ staffId: staffA.toString(), date: '2026-11-22' }),
    });
    const shiftId = (await shRes.json()).shift._id;

    const earlyOut = await fetch(`${baseUrl}/api/admin/staff/shifts/${shiftId}/clock-out`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(earlyOut.status).toBe(400);
  });

  it('prevents Telegram ID spoofing and PII leaks on public waitlist endpoints', async () => {
    // Public join attempts to spoof victim's telegramId in body
    const joinRes = await fetch(`${baseUrl}/api/shops/${shopA._id}/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Public Walkin',
        customerPhone: '+998907778899',
        telegramId: 999888777, // Attempted spoof!
      }),
    });
    expect(joinRes.status).toBe(201);
    const joinData = await joinRes.json();
    expect(joinData.entry.telegramId).toBeNull();

    // Public status check must strip PII (customerPhone, telegramId, notes)
    const statusRes = await fetch(`${baseUrl}/api/shops/${shopA._id}/waitlist/${joinData.entry._id}`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.entry.queueNumber).toBe(1);
    expect(statusData.entry.customerPhone).toBeUndefined();
    expect(statusData.entry.telegramId).toBeUndefined();
    expect(statusData.entry.notes).toBeUndefined();

    // Admin completes entry, then tries to move it back to called -> 400
    await fetch(`${baseUrl}/api/admin/waitlist/${joinData.entry._id}/complete`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const reopen = await fetch(`${baseUrl}/api/admin/waitlist/${joinData.entry._id}/call`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(reopen.status).toBe(400);
  });

  it('sanitizes NoSQL injection & invalid CRM broadcast payloads', async () => {
    const badSegment = await fetch(`${baseUrl}/api/admin/crm/broadcast-reengagement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ targetSegment: { $ne: '' } }),
    });
    expect(badSegment.status).toBe(400);

    const badTemplate = await fetch(`${baseUrl}/api/admin/crm/broadcast-reengagement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ targetSegment: 'at_risk', messageTemplate: { evil: true } }),
    });
    expect(badTemplate.status).toBe(400);
  });
});
