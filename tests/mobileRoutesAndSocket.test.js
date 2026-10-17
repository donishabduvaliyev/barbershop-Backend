import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Review from '../models/review.js';
import MobileAuthSession from '../models/mobileAuthSession.js';
import mobileRouter from '../routes/mobile/index.js';
import webRouter from '../routes/web/index.js';
import shopRoutes from '../routes/shops.js';
import userRouter from '../routes/userData.js';
import { signMobileCustomerToken } from '../middleware/telegramAuth.js';
import { setIO, emitToShop, emitToUser, emitToAuthSession } from '../config/socket.js';

const TEST_BOT_TOKEN = '123456789:ABCDEF_test_bot_token_for_hmac';
const WORKING_HOURS = [
  {
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    from: '09:00',
    to: '21:00',
  },
];

function buildSignedInitData(userObj, botToken = TEST_BOT_TOKEN) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(userObj));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));

  const dataCheckString = Array.from(params.keys())
    .sort()
    .map((k) => `${k}=${params.get(k)}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function nextWednesday10am() {
  const d = new Date();
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7));
  d.setHours(10, 0, 0, 0);
  return d;
}

async function makeShop(overrides = {}) {
  return ServicesModel.create({
    id: Math.floor(Math.random() * 1_000_000_000),
    name: { en: 'Top Barber', uz: 'Top Barber', ru: 'Top Barber' },
    category: 'Barbershop',
    description: { en: 'Desc', uz: 'Desc', ru: 'Desc' },
    image: 'https://placehold.co/1',
    phone: '+998901234567',
    address: 'Tashkent',
    location: { type: 'Point', coordinates: [69.24, 41.3] },
    isOperational: true,
    rating: 4.0,
    reviewsCount: 1,
    workingHours: WORKING_HOURS,
    ...overrides,
  });
}

let server;
let baseUrl;
let emittedEvents = [];

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
  process.env.TELEGRAM_BOT_USERNAME = 'TestSmartChairBot';
  process.env.TELEGRAM_ADMIN_CHAT_ID = '';
  process.env.JWT_SECRET = 'test-mobile-jwt-secret';

  await setupTestDb();

  const app = express();
  app.use(express.json());
  app.use('/api/mobile', mobileRouter);
  app.use('/api/web', webRouter);
  app.use('/api/shops', shopRoutes);
  app.use('/api/user', userRouter);

  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}, 60_000);

afterAll(async () => {
  setIO(null);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  emittedEvents = [];
  setIO({
    to(room) {
      return {
        emit(event, payload) {
          emittedEvents.push({ room, event, payload });
        },
      };
    },
  });
});

describe('Mobile Telegram Deep-Link Auth Handshake', () => {
  it('creates a pending session on POST /api/mobile/auth/telegram/start and transitions to authenticated/consumed on status poll', async () => {
    // 1. Start handshake
    const startRes = await fetch(`${baseUrl}/api/mobile/auth/telegram/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Pixel 9 Pro', platform: 'android' }),
    });
    expect(startRes.status).toBe(201);
    const startData = await startRes.json();
    expect(startData.sessionToken).toMatch(/^[a-f0-9]{32}$/);
    expect(startData.tgDeepLink).toContain(`start=login_${startData.sessionToken}`);
    expect(startData.webDeepLink).toContain(`start=login_${startData.sessionToken}`);

    // 2. Poll while still pending
    const pendingRes = await fetch(
      `${baseUrl}/api/mobile/auth/telegram/status/${startData.sessionToken}`
    );
    expect(pendingRes.status).toBe(200);
    expect(await pendingRes.json()).toEqual({ status: 'pending' });

    // 3. Simulate Telegram Bot /start login_<token> approval
    await User.create({
      telegramId: '777888999',
      name: 'Rustam',
      username: 'rustam_uz',
      phone: '+998901112233',
      language: 'uz',
    });
    await MobileAuthSession.updateOne(
      { sessionToken: startData.sessionToken },
      { $set: { status: 'authenticated', telegramId: '777888999' } }
    );

    // 4. Poll after bot authentication -> returns JWT and user profile
    const authRes = await fetch(
      `${baseUrl}/api/mobile/auth/telegram/status/${startData.sessionToken}`
    );
    expect(authRes.status).toBe(200);
    const authData = await authRes.json();
    expect(authData.status).toBe('authenticated');
    expect(typeof authData.token).toBe('string');
    expect(authData.user.telegramId).toBe('777888999');
    expect(authData.user.name).toBe('Rustam');

    const updatedSession = await MobileAuthSession.findOne({
      sessionToken: startData.sessionToken,
    });
    expect(updatedSession.status).toBe('consumed');
  });
});

describe('Mobile Customer Profile (/api/mobile/me)', () => {
  it('fetches and updates profile using Mobile Customer Bearer JWT and emits user:updated', async () => {
    await User.create({
      telegramId: '44556677',
      name: 'Dilshod',
      username: 'dilshod_t',
      phone: '+998909998877',
      language: 'ru',
    });

    const mobileJwt = signMobileCustomerToken({
      telegramId: 44556677,
      username: 'dilshod_t',
      name: 'Dilshod',
    });

    // GET /api/mobile/me
    const getRes = await fetch(`${baseUrl}/api/mobile/me`, {
      headers: { Authorization: `Bearer ${mobileJwt}` },
    });
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.platform).toBe('mobile');
    expect(getData.user.name).toBe('Dilshod');
    expect(getData.user.phone).toBe('+998909998877');
    expect(Array.isArray(getData.bookings)).toBe(true);

    // PATCH /api/mobile/me
    const patchRes = await fetch(`${baseUrl}/api/mobile/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mobileJwt}`,
      },
      body: JSON.stringify({
        name: 'Dilshod Karimov',
        email: 'dilshod@example.com',
        language: 'en',
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.user.name).toBe('Dilshod Karimov');
    expect(patchData.user.email).toBe('dilshod@example.com');
    expect(patchData.user.language).toBe('en');

    // Verify real-time user:updated socket event was emitted to user:44556677
    const userEvent = emittedEvents.find(
      (e) => e.room === 'user:44556677' && e.event === 'user:updated'
    );
    expect(userEvent).toBeDefined();
    expect(userEvent.payload.name).toBe('Dilshod Karimov');
  });
});

describe('In-App Mobile Reviews (POST /api/mobile/reviews)', () => {
  it('submits shop + staff ratings, updates running averages, emits live events, and blocks duplicates with 409', async () => {
    const shop = await makeShop({
      rating: 4.0,
      reviewsCount: 1,
      staff: [{ name: 'Master Bobur', rating: 4.0, reviewsCount: 1, workingHours: [] }],
    });
    const staffId = shop.staff[0]._id;

    const booking = await Booking.create({
      shopId: shop._id,
      shopName: shop.name.en,
      staffId,
      staffName: 'Master Bobur',
      userTelegramId: 33445566,
      userName: 'Otabek',
      userNumber: '+998901239876',
      requestedTime: nextWednesday10am(),
      status: 'completed',
    });

    const mobileJwt = signMobileCustomerToken({
      telegramId: 33445566,
      username: 'otabek',
      name: 'Otabek',
    });

    const res1 = await fetch(`${baseUrl}/api/mobile/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mobileJwt}`,
      },
      body: JSON.stringify({
        bookingId: booking._id.toString(),
        rating: 5,
        staffRating: 5,
      }),
    });
    expect(res1.status).toBe(201);
    const data1 = await res1.json();
    expect(data1.review.rating).toBe(5);
    expect(data1.review.staffRating).toBe(5);

    // Check updated averages: (4.0 * 1 + 5) / 2 = 4.5
    const updatedShop = await ServicesModel.findById(shop._id);
    expect(updatedShop.rating).toBe(4.5);
    expect(updatedShop.reviewsCount).toBe(2);
    expect(updatedShop.staff[0].rating).toBe(4.5);
    expect(updatedShop.staff[0].reviewsCount).toBe(2);

    // Check socket events emitted to user and shop
    expect(
      emittedEvents.some((e) => e.room === 'user:33445566' && e.event === 'booking:rated')
    ).toBe(true);
    expect(
      emittedEvents.some((e) => e.room === `shop:${shop._id}` && e.event === 'review:created')
    ).toBe(true);

    // Duplicate review should return 409
    const res2 = await fetch(`${baseUrl}/api/mobile/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mobileJwt}`,
      },
      body: JSON.stringify({
        bookingId: booking._id.toString(),
        rating: 4,
      }),
    });
    expect(res2.status).toBe(409);
  });
});

describe('Real-Time Socket.io Broadcasting Helpers (emitToShop, emitToUser, emitToAuthSession)', () => {
  it('fans out appointment:update to shop:<shopId>, user:<telegramId>, and public:shop:<shopId>', () => {
    const fakeShopId = '607f1f77bcf86cd799439099';
    const fakeBooking = {
      _id: '607f1f77bcf86cd799439088',
      shopId: fakeShopId,
      userTelegramId: 99881122,
      requestedTime: new Date('2026-11-01T10:00:00Z'),
      status: 'confirmed',
      staffId: null,
    };

    emitToShop(fakeShopId, 'appointment:update', fakeBooking);
    emitToUser(99881122, 'custom:ping', { ok: true });
    emitToAuthSession('abcdef0123456789abcdef0123456789', 'auth:approved', {
      status: 'authenticated',
    });

    expect(emittedEvents).toEqual([
      {
        room: `shop:${fakeShopId}`,
        event: 'appointment:update',
        payload: fakeBooking,
      },
      {
        room: 'user:99881122',
        event: 'booking:updated',
        payload: fakeBooking,
      },
      {
        room: `public:shop:${fakeShopId}`,
        event: 'availability:updated',
        payload: {
          shopId: fakeShopId,
          bookingId: fakeBooking._id,
          requestedTime: fakeBooking.requestedTime,
          status: 'confirmed',
          staffId: null,
        },
      },
      {
        room: 'user:99881122',
        event: 'custom:ping',
        payload: { ok: true },
      },
      {
        room: 'auth:abcdef0123456789abcdef0123456789',
        event: 'auth:approved',
        payload: { status: 'authenticated' },
      },
    ]);
  });
});

describe('Automatic Web (initData) vs Mobile (Bearer JWT) Switching on Shared Routes', () => {
  it('allows the same user to toggle favorites from Web (initData) and book from Mobile (Bearer JWT)', async () => {
    const shop = await makeShop();
    const telegramId = 55667788;

    await User.create({
      telegramId: String(telegramId),
      name: 'Kamol',
      username: 'kamol_uz',
      phone: '+998905554433',
      favorites: [],
    });

    const webInitData = buildSignedInitData({
      id: telegramId,
      first_name: 'Kamol',
      username: 'kamol_uz',
    });

    const mobileJwt = signMobileCustomerToken({
      telegramId,
      username: 'kamol_uz',
      name: 'Kamol',
    });

    // 1. Web client toggles favorite via x-telegram-init-data
    const favWebRes = await fetch(`${baseUrl}/api/user/favorites/toggle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-init-data': webInitData,
      },
      body: JSON.stringify({ shopId: shop._id.toString() }),
    });
    expect(favWebRes.status).toBe(200);
    const favWebData = await favWebRes.json();
    expect(favWebData.isFavorited).toBe(true);
    expect(favWebData.favorites).toContain(shop._id.toString());

    // 2. Mobile client creates a booking on the shared /api/shops/booking-requests endpoint via Bearer JWT
    const bookingRes = await fetch(`${baseUrl}/api/shops/booking-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mobileJwt}`,
      },
      body: JSON.stringify({
        shopId: shop._id.toString(),
        shopName: shop.name.en,
        requestedTime: nextWednesday10am().toISOString(),
        userNumber: '+998905554433',
        userName: 'Kamol',
        lang: 'uz',
      }),
    });
    expect(bookingRes.status).toBe(201);

    // 3. Verify booking is visible in Mobile /api/mobile/me and favorite is synced
    const meRes = await fetch(`${baseUrl}/api/mobile/me`, {
      headers: { Authorization: `Bearer ${mobileJwt}` },
    });
    expect(meRes.status).toBe(200);
    const meData = await meRes.json();
    expect(meData.user.favorites.map(String)).toContain(shop._id.toString());
    expect(meData.bookings.length).toBe(1);
    expect(meData.bookings[0].userName).toBe('Kamol');
  });
});
