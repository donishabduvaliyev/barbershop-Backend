// Locks down the atomic-transition fix — confirmBooking/rejectBooking/etc.
// used to be a plain findById + status check + save, which left a real race
// window for two rapid taps (or a tap racing the reminder sweep). All test
// bookings here use a synthetic negative userTelegramId, so notifyUser's
// own guard skips any real Telegram API call — nothing here needs a bot
// token or network access.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { confirmBooking, rejectBooking, cancelBooking } from '../services/bookingActions.js';

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

async function makePendingBooking(shop) {
  return Booking.create({
    shopId: shop._id, shopName: shop.name.en, userTelegramId: -1,
    userName: 'Test', userNumber: '+998900000001',
    requestedTime: new Date(Date.now() + 3600_000), status: 'pending', userLanguage: 'en',
  });
}

beforeAll(async () => { await setupTestDb(); }, 60_000);
afterAll(async () => { await teardownTestDb(); });
beforeEach(async () => { await clearTestDb(); });

describe('confirmBooking — atomic double-tap race', () => {
  it('two concurrent confirms on the same pending booking both resolve to "confirmed", never corrupted', async () => {
    const shop = await makeShop();
    const booking = await makePendingBooking(shop);

    const [r1, r2] = await Promise.all([confirmBooking(booking._id), confirmBooking(booking._id)]);
    expect(r1.status).toBe('confirmed');
    expect(r2.status).toBe('confirmed');

    const final = await Booking.findById(booking._id);
    expect(final.status).toBe('confirmed');
  });

  it('is a no-op on a booking that is not pending', async () => {
    const shop = await makeShop();
    const booking = await makePendingBooking(shop);
    await Booking.updateOne({ _id: booking._id }, { $set: { status: 'rejected' } });

    const result = await confirmBooking(booking._id);
    expect(result.status).toBe('rejected'); // unchanged, not silently flipped to confirmed
  });

  it('returns null for a booking that does not exist', async () => {
    const result = await confirmBooking('507f1f77bcf86cd799439011');
    expect(result).toBeNull();
  });
});

describe('rejectBooking — confirm and reject racing each other', () => {
  // rejectBooking's own guard deliberately accepts a booking that's already
  // `confirmed` (an owner can reject something they just confirmed), which
  // is a strict superset of confirmBooking's `pending`-only guard — so
  // reject always wins this race regardless of which atomic write actually
  // reaches the database first: either it runs first and claims the
  // still-pending booking directly, or it runs second and claims the
  // now-confirmed one. What the atomic rewrite guarantees is that this
  // resolves deterministically to one real state, never a corrupted or
  // duplicated one.
  it('always resolves to "rejected", and never throws or corrupts state either way', async () => {
    const shop = await makeShop();
    const booking = await makePendingBooking(shop);

    await expect(Promise.all([
      confirmBooking(booking._id),
      rejectBooking(booking._id, 'test reason'),
    ])).resolves.toBeDefined();

    const final = await Booking.findById(booking._id);
    expect(final.status).toBe('rejected');
    expect(final.rejectionReason).toBe('test reason');
  });
});

describe('cancelBooking', () => {
  it('cancels a confirmed booking and records the reason', async () => {
    const shop = await makeShop();
    const booking = await makePendingBooking(shop);
    await Booking.updateOne({ _id: booking._id }, { $set: { status: 'confirmed' } });

    const result = await cancelBooking(booking._id, 'schedule changed');
    expect(result.status).toBe('cancelled');
    expect(result.rejectionReason).toBe('schedule changed');
  });

  it('does not cancel an already-completed booking', async () => {
    const shop = await makeShop();
    const booking = await makePendingBooking(shop);
    await Booking.updateOne({ _id: booking._id }, { $set: { status: 'completed' } });

    const result = await cancelBooking(booking._id);
    expect(result.status).toBe('completed');
  });
});

describe('rejectBooking — fromStatuses guard', () => {
  // Regression test for a real bug: jobs/pendingBookingSweep.js builds its
  // candidate list from a `status:'pending'` snapshot, then reject-ies each
  // one with real I/O (Telegram sends) in between. Without restricting
  // fromStatuses to just ['pending'], the default (broader) guard would let
  // the sweep silently flip a booking an owner just confirmed back to
  // rejected, since that default guard also accepts 'confirmed'.
  it('with fromStatuses: ["pending"], does not touch a booking that is already confirmed', async () => {
    const shop = await makeShop();
    const booking = await makePendingBooking(shop);
    await Booking.updateOne({ _id: booking._id }, { $set: { status: 'confirmed' } });

    const result = await rejectBooking(booking._id, 'auto-expired', { fromStatuses: ['pending'] });
    expect(result.status).toBe('confirmed'); // unchanged — the whole point of the guard

    const final = await Booking.findById(booking._id);
    expect(final.status).toBe('confirmed');
  });

  it('without an explicit fromStatuses, still rejects an already-confirmed booking (existing behavior other callers rely on)', async () => {
    const shop = await makeShop();
    const booking = await makePendingBooking(shop);
    await Booking.updateOne({ _id: booking._id }, { $set: { status: 'confirmed' } });

    const result = await rejectBooking(booking._id, 'staff called in sick');
    expect(result.status).toBe('rejected');
  });
});
