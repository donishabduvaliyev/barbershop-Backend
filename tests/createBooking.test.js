// Integration tests against a real in-memory MongoDB — this is the single
// shared path every booking (customer-app or admin manual entry) goes
// through, so a regression here is the highest-blast-radius kind there is.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Customer from '../models/customer.js';
import { createBooking, BookingConflictError, BookingNotFoundError } from '../services/createBooking.js';
import { BookingValidationError } from '../utils/bookingTime.js';

const WORKING_HOURS = [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], from: '09:00', to: '21:00' }];

function nextWednesday10am() {
  // A fixed, always-future Wednesday 10:00 Tashkent time, so tests never
  // become flaky depending on when they happen to run.
  const d = new Date();
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7)); // next Wednesday, never today
  d.setHours(10, 0, 0, 0);
  return d;
}

async function makeShop(overrides = {}) {
  return ServicesModel.create({
    id: Math.floor(Math.random() * 1_000_000_000),
    name: { en: 'Test Shop', uz: 'Test', ru: 'Test' },
    category: 'Barbershop',
    description: { en: 't', uz: 't', ru: 't' },
    image: 'https://placehold.co/1',
    phone: '+998900000000',
    address: 'test address',
    location: { type: 'Point', coordinates: [69.24, 41.30] },
    isOperational: true,
    workingHours: WORKING_HOURS,
    ...overrides,
  });
}

beforeAll(async () => { await setupTestDb(); }, 60_000);
afterAll(async () => { await teardownTestDb(); });
beforeEach(async () => { await clearTestDb(); });

describe('createBooking — basic validation', () => {
  it('throws BookingNotFoundError for a shop that does not exist', async () => {
    await expect(createBooking({
      shopId: new mongoose.Types.ObjectId(),
      requestedTime: nextWednesday10am(),
      userTelegramId: 111,
      userNumber: '+998900000001',
      userName: 'Test User',
    })).rejects.toBeInstanceOf(BookingNotFoundError);
  });

  it('throws BookingConflictError when the shop is not operational and checkShopOperational is true', async () => {
    const shop = await makeShop({ isOperational: false });
    await expect(createBooking({
      shopId: shop._id, requestedTime: nextWednesday10am(),
      userTelegramId: 111, userNumber: '+998900000001', userName: 'Test User',
      checkShopOperational: true,
    })).rejects.toBeInstanceOf(BookingConflictError);
  });

  it('allows a manual (admin) booking on a non-operational shop when checkShopOperational is false', async () => {
    const shop = await makeShop({ isOperational: false });
    const booking = await createBooking({
      shopId: shop._id, requestedTime: nextWednesday10am(),
      userTelegramId: 111, userNumber: '+998900000001', userName: 'Test User',
      source: 'walk-in', checkShopOperational: false,
    });
    expect(booking.status).toBe('pending');
  });

  it('rejects an out-of-hours time', async () => {
    const shop = await makeShop();
    const midnight = nextWednesday10am();
    midnight.setHours(23);
    await expect(createBooking({
      shopId: shop._id, requestedTime: midnight,
      userTelegramId: 111, userNumber: '+998900000001', userName: 'Test User',
    })).rejects.toBeInstanceOf(BookingValidationError);
  });
});

describe('createBooking — staff-specific conflicts (unique-index race safety)', () => {
  it('rejects a second booking for the same staff member at the same hour', async () => {
    const shop = await makeShop();
    shop.staff.push({ name: 'Aziz', workingHours: [] });
    await shop.save();
    const staffId = shop.staff[0]._id;
    const time = nextWednesday10am();

    await createBooking({
      shopId: shop._id, staffId, requestedTime: time,
      userTelegramId: 111, userNumber: '+998900000001', userName: 'First',
    });

    await expect(createBooking({
      shopId: shop._id, staffId, requestedTime: time,
      userTelegramId: 222, userNumber: '+998900000002', userName: 'Second',
    })).rejects.toBeInstanceOf(BookingConflictError);
  });

  it('allows two different staff members to be booked at the same hour', async () => {
    const shop = await makeShop();
    shop.staff.push({ name: 'Aziz', workingHours: [] }, { name: 'Bobur', workingHours: [] });
    await shop.save();
    const time = nextWednesday10am();

    await createBooking({ shopId: shop._id, staffId: shop.staff[0]._id, requestedTime: time, userTelegramId: 111, userNumber: '+998900000001', userName: 'First' });
    const second = await createBooking({ shopId: shop._id, staffId: shop.staff[1]._id, requestedTime: time, userTelegramId: 222, userNumber: '+998900000002', userName: 'Second' });
    expect(second.status).toBe('pending');
  });

  it('frees the slot once the first booking is cancelled (partial unique index)', async () => {
    const shop = await makeShop();
    shop.staff.push({ name: 'Aziz', workingHours: [] });
    await shop.save();
    const staffId = shop.staff[0]._id;
    const time = nextWednesday10am();

    const first = await createBooking({ shopId: shop._id, staffId, requestedTime: time, userTelegramId: 111, userNumber: '+998900000001', userName: 'First' });
    await Booking.updateOne({ _id: first._id }, { $set: { status: 'cancelled' } });

    const second = await createBooking({ shopId: shop._id, staffId, requestedTime: time, userTelegramId: 222, userNumber: '+998900000002', userName: 'Second' });
    expect(second.status).toBe('pending');
  });
});

describe('createBooking — "any available" capacity (virtualSlot claiming)', () => {
  it('fills a staffless shop up to its capacity, then rejects the next', async () => {
    const shop = await makeShop({ capacity: 2 });
    const time = nextWednesday10am();

    await createBooking({ shopId: shop._id, requestedTime: time, userTelegramId: 111, userNumber: '+998900000001', userName: 'First' });
    await createBooking({ shopId: shop._id, requestedTime: time, userTelegramId: 222, userNumber: '+998900000002', userName: 'Second' });

    await expect(createBooking({
      shopId: shop._id, requestedTime: time, userTelegramId: 333, userNumber: '+998900000003', userName: 'Third',
    })).rejects.toBeInstanceOf(BookingConflictError);
  });

  it('a staff member off that day does not count toward "any available" capacity', async () => {
    const shop = await makeShop();
    const time = nextWednesday10am();
    const dayKey = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;
    shop.staff.push({ name: 'Aziz', workingHours: [], daysOff: [dayKey] }, { name: 'Bobur', workingHours: [] });
    await shop.save();

    // Only Bobur is actually available — capacity should be 1, not 2.
    await createBooking({ shopId: shop._id, requestedTime: time, userTelegramId: 111, userNumber: '+998900000001', userName: 'First' });
    await expect(createBooking({
      shopId: shop._id, requestedTime: time, userTelegramId: 222, userNumber: '+998900000002', userName: 'Second',
    })).rejects.toBeInstanceOf(BookingConflictError);
  });
});

describe('createBooking — a customer cannot double-book themselves', () => {
  it('rejects a second booking for the same customer at the same time, even at a different shop', async () => {
    const shopA = await makeShop();
    const shopB = await makeShop();
    const time = nextWednesday10am();

    await createBooking({ shopId: shopA._id, requestedTime: time, userTelegramId: 111, userNumber: '+998900000001', userName: 'Same Person' });
    await expect(createBooking({
      shopId: shopB._id, requestedTime: time, userTelegramId: 111, userNumber: '+998900000001', userName: 'Same Person',
    })).rejects.toBeInstanceOf(BookingConflictError);
  });
});

describe('createBooking — blocked customers are refused', () => {
  it('rejects a booking from a customer the shop has blocked', async () => {
    const shop = await makeShop();
    await Customer.create({ shopId: shop._id, telegramId: 111, name: 'Repeat No-Show', number: '+998900000001', isBlocked: true });

    await expect(createBooking({
      shopId: shop._id, requestedTime: nextWednesday10am(),
      userTelegramId: 111, userNumber: '+998900000001', userName: 'Repeat No-Show',
    })).rejects.toBeInstanceOf(BookingConflictError);
  });

  it('allows a booking again once unblocked', async () => {
    const shop = await makeShop();
    await Customer.create({ shopId: shop._id, telegramId: 111, name: 'Reformed', number: '+998900000001', isBlocked: false });

    const booking = await createBooking({
      shopId: shop._id, requestedTime: nextWednesday10am(),
      userTelegramId: 111, userNumber: '+998900000001', userName: 'Reformed',
    });
    expect(booking.status).toBe('pending');
  });
});

describe('createBooking — service validation', () => {
  it('rejects an inactive service', async () => {
    const shop = await makeShop();
    shop.services.push({ name: { en: 'Haircut', uz: 'H', ru: 'H' }, price: 50000, durationMinutes: 30, isActive: false });
    await shop.save();

    await expect(createBooking({
      shopId: shop._id, requestedTime: nextWednesday10am(), serviceId: shop.services[0]._id,
      userTelegramId: 111, userNumber: '+998900000001', userName: 'Test User',
    })).rejects.toBeInstanceOf(BookingValidationError);
  });

  it('rejects a staff member booked for a service they do not perform', async () => {
    const shop = await makeShop();
    shop.services.push({ name: { en: 'Manicure', uz: 'M', ru: 'M' }, price: 30000, durationMinutes: 30 });
    await shop.save();
    const otherServiceId = new mongoose.Types.ObjectId();
    shop.staff.push({ name: 'Aziz', workingHours: [], serviceIds: [otherServiceId] }); // restricted to a service that isn't this one
    await shop.save();

    await expect(createBooking({
      shopId: shop._id, requestedTime: nextWednesday10am(),
      staffId: shop.staff[0]._id, serviceId: shop.services[0]._id,
      userTelegramId: 111, userNumber: '+998900000001', userName: 'Test User',
    })).rejects.toBeInstanceOf(BookingValidationError);
  });
});
