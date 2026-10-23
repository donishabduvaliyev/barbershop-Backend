import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import BusinessInquiry from '../models/businessInquiry.js';
import DataDeletionRequest from '../models/dataDeletionRequest.js';
import publicInquiriesRouter from '../routes/publicInquiries.js';

let server;
let baseUrl;

beforeAll(async () => {
  process.env.TELEGRAM_ADMIN_CHAT_ID = '';
  await setupTestDb();

  const app = express();
  app.use(express.json());
  app.use('/api/public', publicInquiriesRouter);

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

describe('Public B2B Inquiries & Data Deletion Endpoints', () => {
  it('POST /api/public/business-inquiries rejects missing required fields or missing consent', async () => {
    const res1 = await fetch(`${baseUrl}/api/public/business-inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Crown Barber',
        ownerName: 'Sardor',
        phone: '+998901234567',
        consentAccepted: false,
      }),
    });
    expect(res1.status).toBe(400);

    const res2 = await fetch(`${baseUrl}/api/public/business-inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: '',
        ownerName: 'Sardor',
        phone: '+998901234567',
        consentAccepted: true,
      }),
    });
    expect(res2.status).toBe(400);
  });

  it('POST /api/public/business-inquiries saves valid B2B inquiry to MongoDB', async () => {
    const res = await fetch(`${baseUrl}/api/public/business-inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Royal Blade Barbershop',
        ownerName: 'Azizbek Karimov',
        phone: '+998 94 982 70 70',
        category: 'barber',
        city: 'Namangan',
        staffCount: '3-5',
        telegramOrInstagram: '@royalblade_uz',
        message: 'We have 4 chairs and want to connect to SmartChair.',
        consentAccepted: true,
        language: 'uz',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.inquiryId).toBeDefined();

    const saved = await BusinessInquiry.findById(body.inquiryId).lean();
    expect(saved).toBeTruthy();
    expect(saved.businessName).toBe('Royal Blade Barbershop');
    expect(saved.ownerName).toBe('Azizbek Karimov');
    expect(saved.phone).toBe('+998 94 982 70 70');
    expect(saved.category).toBe('barber');
    expect(saved.city).toBe('Namangan');
    expect(saved.staffCount).toBe('3-5');
    expect(saved.consentAccepted).toBe(true);
    expect(saved.status).toBe('new');
  });

  it('POST /api/public/data-deletion-requests validates identifier and saves deletion request', async () => {
    const badRes = await fetch(`${baseUrl}/api/public/data-deletion-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: '',
        telegramUsername: '',
        confirmDeletion: true,
      }),
    });
    expect(badRes.status).toBe(400);

    const goodRes = await fetch(`${baseUrl}/api/public/data-deletion-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: '+998901112233',
        telegramUsername: '@testcustomer',
        reason: 'No longer using the service',
        confirmDeletion: true,
        language: 'uz',
      }),
    });
    expect(goodRes.status).toBe(201);
    const body = await goodRes.json();
    expect(body.success).toBe(true);
    expect(body.requestId).toBeDefined();

    const saved = await DataDeletionRequest.findById(body.requestId).lean();
    expect(saved).toBeTruthy();
    expect(saved.phone).toBe('+998901112233');
    expect(saved.telegramUsername).toBe('@testcustomer');
    expect(saved.status).toBe('pending');
  });
});
