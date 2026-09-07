// Matches server.js's TZ pinning — must be the very first line, before any
// Date math, so this script's day/hour expectations agree with the server
// process (also pinned to Asia/Tashkent) being tested against.
process.env.TZ = 'Asia/Tashkent';

import 'dotenv/config';
import mongoose from 'mongoose';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { assertBookableTime, isWithinWorkingHours, BookingValidationError } from '../utils/bookingTime.js';

const BASE = 'http://localhost:5999/api';
let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); failures++; }
  else console.log('✅', msg);
}

// A near-future hour, tomorrow, safely inside the 08:00-22:00 test window
// below regardless of what time this script happens to run.
function tomorrowAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // Clean any leftovers from a previous crashed run before seeding fresh.
  const stale = await ServicesModel.find({ 'name.en': { $in: ['AvailNow Test Shop A', 'AvailNow Test Shop B'] } });
  const staleIds = stale.map((s) => s._id);
  await Booking.deleteMany({ shopId: { $in: staleIds } });
  await ServicesModel.deleteMany({ _id: { $in: staleIds } });

  let shopA, shopB;
  try {
    shopA = await ServicesModel.create({
      id: Date.now() % 1_000_000_000,
      name: { en: 'AvailNow Test Shop A', uz: 'AvailNow Test Do\'kon A', ru: 'AvailNow Тест Магазин А' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://placehold.co/200',
      phone: '+998900000101',
      address: 'Test address A',
      location: { type: 'Point', coordinates: [69.24, 41.30] },
      isOperational: true,
      workingHours: [{ days: ALL_DAYS, from: '08:00', to: '22:00' }],
      services: [{ name: { en: 'Test Haircut Alpha', uz: 'Test Soch Olish Alpha', ru: 'Тест Стрижка Альфа' }, price: 50000, durationMinutes: 30 }],
      staff: [{ name: 'Staff A1', daysOff: [], serviceIds: [] }],
    });
    shopB = await ServicesModel.create({
      id: (Date.now() + 1) % 1_000_000_000,
      name: { en: 'AvailNow Test Shop B', uz: 'AvailNow Test Do\'kon B', ru: 'AvailNow Тест Магазин Б' },
      category: 'Barbershop',
      description: { en: 'Test', uz: 'Test', ru: 'Тест' },
      image: 'https://placehold.co/200',
      phone: '+998900000102',
      address: 'Test address B',
      location: { type: 'Point', coordinates: [69.25, 41.31] },
      isOperational: true,
      workingHours: [{ days: ALL_DAYS, from: '08:00', to: '22:00' }],
      services: [{ name: { en: 'Test Haircut Beta', uz: 'Test Soch Olish Beta', ru: 'Тест Стрижка Бета' }, price: 40000, durationMinutes: 30 }],
      staff: [], // staffless — capacity-based (default capacity: 1)
    });

    const openHour = tomorrowAt(14); // 14:00, well within 08:00-22:00
    const closedHour = tomorrowAt(3); // 03:00, outside working hours

    // --- Test 1: both shops available at an open hour, no existing bookings ---
    let res = await fetch(`${BASE}/shops/available-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceQuery: 'Haircut', requestedTime: openHour.toISOString() }),
    });
    let data = await res.json();
    assert(res.status === 200, 'available-now returns 200 for an open hour');
    const namesAtOpenHour = (data.results || []).map((r) => r.name.en);
    assert(namesAtOpenHour.includes('AvailNow Test Shop A'), 'Shop A (staffed) appears as available');
    assert(namesAtOpenHour.includes('AvailNow Test Shop B'), 'Shop B (staffless, capacity 1) appears as available');
    const shopAResult = data.results.find((r) => r.name.en === 'AvailNow Test Shop A');
    assert(shopAResult?.matchedServices?.[0]?.name?.en === 'Test Haircut Alpha', 'Shop A result includes the matched service name');

    // --- Test 2: fill Shop B's only capacity slot, re-run — Shop B should drop out, Shop A stays ---
    await Booking.create({
      shopId: shopB._id, shopName: shopB.name.en, userTelegramId: 42424242, userName: 'Filler',
      userNumber: '+998900000000', requestedTime: openHour, status: 'confirmed',
      serviceId: shopB.services[0]._id, serviceName: shopB.services[0].name.en, price: shopB.services[0].price,
    });
    res = await fetch(`${BASE}/shops/available-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceQuery: 'Haircut', requestedTime: openHour.toISOString() }),
    });
    data = await res.json();
    const namesAfterFill = (data.results || []).map((r) => r.name.en);
    assert(!namesAfterFill.includes('AvailNow Test Shop B'), 'Shop B drops out once its only capacity slot is booked');
    assert(namesAfterFill.includes('AvailNow Test Shop A'), 'Shop A (separate capacity pool) is unaffected by Shop B\'s booking');

    // --- Test 3: closed hour — both shops excluded ---
    res = await fetch(`${BASE}/shops/available-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceQuery: 'Haircut', requestedTime: closedHour.toISOString() }),
    });
    data = await res.json();
    assert(res.status === 200 && (data.results || []).length === 0, 'closed hour (03:00) returns no results for either shop');

    // --- Test 4: non-matching query — no shops match by name ---
    res = await fetch(`${BASE}/shops/available-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceQuery: 'Massage Therapy Zzz Nonexistent', requestedTime: openHour.toISOString() }),
    });
    data = await res.json();
    assert(res.status === 200 && (data.results || []).length === 0, 'a query matching no service name returns an empty result set');

    // --- Test 5: validation — past time and empty query rejected ---
    const pastTime = new Date(Date.now() - 60 * 60 * 1000);
    res = await fetch(`${BASE}/shops/available-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceQuery: 'Haircut', requestedTime: pastTime.toISOString() }),
    });
    assert(res.status === 400, 'a past requestedTime is rejected with 400');

    res = await fetch(`${BASE}/shops/available-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceQuery: '   ', requestedTime: openHour.toISOString() }),
    });
    assert(res.status === 400, 'a blank serviceQuery is rejected with 400');

    // --- Test 6: regression on the refactored utils/bookingTime.js — hits the
    // booking-requests HTTP route requires signed Telegram initData (out of
    // scope to fake here), so this exercises the exact refactored functions
    // directly instead: assertBookableTime is the single-shop write-path
    // validator that /available-now's isWithinWorkingHours was extracted
    // from, so confirming its existing throw/pass behavior and error
    // messages are byte-for-byte unchanged is the real regression check.
    let threw = null;
    try { assertBookableTime(shopA.workingHours, openHour, shopA.name.en); } catch (e) { threw = e; }
    assert(threw === null, 'assertBookableTime does not throw for a valid open-hour slot (unchanged behavior)');

    threw = null;
    try { assertBookableTime(shopA.workingHours, closedHour, shopA.name.en); } catch (e) { threw = e; }
    // The test shop is open every day (ALL_DAYS), so an out-of-range hour
    // hits the "only open X–Y" branch, not the "closed on {day}s" branch
    // (that one only fires when no schedule entry covers the day at all).
    assert(threw instanceof BookingValidationError && /is only open/.test(threw.message), 'assertBookableTime still rejects an out-of-hours time with the same "is only open" message');

    const halfHour = new Date(openHour); halfHour.setMinutes(30);
    threw = null;
    try { assertBookableTime(shopA.workingHours, halfHour, shopA.name.en); } catch (e) { threw = e; }
    assert(threw instanceof BookingValidationError && /only be booked on the hour/.test(threw.message), 'assertBookableTime still rejects a non-hour-aligned time with the same message');

    threw = null;
    try { assertBookableTime(shopA.workingHours, pastTime, shopA.name.en); } catch (e) { threw = e; }
    assert(threw instanceof BookingValidationError && /already passed/.test(threw.message), 'assertBookableTime still rejects a past time with the same message');

    assert(isWithinWorkingHours(shopA.workingHours, openHour) === true, 'isWithinWorkingHours agrees with assertBookableTime on an open hour');
    assert(isWithinWorkingHours(shopA.workingHours, closedHour) === false, 'isWithinWorkingHours agrees with assertBookableTime on a closed hour');
    assert(isWithinWorkingHours(shopA.workingHours, halfHour) === true, 'isWithinWorkingHours (unlike assertBookableTime) does not require on-the-hour alignment — by design, it only answers "is the shop open right now"');
  } finally {
    const shopIds = [shopA?._id, shopB?._id].filter(Boolean);
    await Booking.deleteMany({ shopId: { $in: shopIds } });
    await ServicesModel.deleteMany({ _id: { $in: shopIds } });
  }

  console.log(failures === 0 ? '\n🎉 ALL PASSED' : `\n💥 ${failures} FAILURE(S)`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Test script crashed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
