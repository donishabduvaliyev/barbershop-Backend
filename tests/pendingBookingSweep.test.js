// Locks down the fix for "a pending booking with no response just hangs
// forever" — verifies the exact three scenarios manually checked during
// that fix: a stale booking expires, a fresh one is left alone, and one
// whose slot time already passed expires immediately regardless of age.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { runPendingBookingSweep } from '../jobs/pendingBookingSweep.js';

async function makeShop() {
  return ServicesModel.create({
    id: Math.floor(Math.random() * 1_000_000_000),
    name: { en: 'Test Shop', uz: 'Test', ru: 'Test' },
    category: 'Barbershop',
    description: { en: 't', uz: 't', ru: 't' },
    image: 'https://placehold.co/1',
    phone: '+998900000000',
    address: 'test',
    location: { type: 'Point', coordinates: [69.24, 41.30] },
  });
}

beforeAll(async () => { await setupTestDb(); }, 60_000);
afterAll(async () => { await teardownTestDb(); });
beforeEach(async () => { await clearTestDb(); });

describe('pending-booking auto-expire sweep', () => {
  it('expires a booking pending longer than the timeout, leaves a fresh one alone, and catches a missed-window one immediately', async () => {
    const shop = await makeShop();

    const stale = await Booking.create({
      shopId: shop._id, shopName: shop.name.en, userTelegramId: -1,
      userName: 'Stale', userNumber: '+998900000001',
      requestedTime: new Date(Date.now() + 48 * 3600_000), status: 'pending', userLanguage: 'en',
    });
    // Model.updateOne() silently ignores an explicit createdAt in $set
    // (Mongoose's timestamps plugin protects it) — go through the raw
    // driver collection to actually backdate it for this test.
    await mongoose.connection.collection('BookingData').updateOne(
      { _id: stale._id },
      { $set: { createdAt: new Date(Date.now() - 25 * 3600_000) } }
    );

    const fresh = await Booking.create({
      shopId: shop._id, shopName: shop.name.en, userTelegramId: -2,
      userName: 'Fresh', userNumber: '+998900000002',
      requestedTime: new Date(Date.now() + 3 * 3600_000), status: 'pending', userLanguage: 'en',
    });

    const missedWindow = await Booking.create({
      shopId: shop._id, shopName: shop.name.en, userTelegramId: -3,
      userName: 'MissedWindow', userNumber: '+998900000003',
      requestedTime: new Date(Date.now() - 3600_000), status: 'pending', userLanguage: 'en',
    });

    await runPendingBookingSweep();

    const staleAfter = await Booking.findById(stale._id);
    const freshAfter = await Booking.findById(fresh._id);
    const missedAfter = await Booking.findById(missedWindow._id);

    expect(staleAfter.status).toBe('rejected');
    expect(staleAfter.rejectionReason).toBe("The shop didn't respond in time");
    expect(freshAfter.status).toBe('pending');
    expect(missedAfter.status).toBe('rejected');
  }, 15_000);
});
