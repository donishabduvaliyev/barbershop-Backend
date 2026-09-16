// Pure unit tests, no database — this is the single most bug-prone piece of
// logic in the app (the multi-range/lunch-break bug was found and fixed
// here twice: once server-side, once again in the client's own copy of the
// same logic). Locks down the exact scenarios that broke before.
process.env.TZ = 'Asia/Tashkent';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertBookableTime, isWithinWorkingHours, BookingValidationError } from '../utils/bookingTime.js';

// A fixed "now" so future/past assertions are deterministic regardless of
// when the suite actually runs. Wednesday, so the lunch-break fixture's
// "Wednesday" entry always applies.
const FIXED_NOW = new Date('2026-09-16T05:00:00.000Z'); // 10:00 Tashkent (UTC+5)

function tashkentHour(hour, dayOffset = 0) {
  // Builds a Date whose *local* (process TZ = Asia/Tashkent) hour matches
  // the given value, on the day dayOffset days after FIXED_NOW.
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

const LUNCH_BREAK_HOURS = [
  { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], from: '09:00', to: '13:00' },
  { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], from: '14:00', to: '21:00' },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('assertBookableTime — multi-range working hours (lunch breaks)', () => {
  it('allows a slot in the morning range', () => {
    expect(() => assertBookableTime(LUNCH_BREAK_HOURS, tashkentHour(10, 1))).not.toThrow();
  });

  it('allows a slot in the afternoon range', () => {
    expect(() => assertBookableTime(LUNCH_BREAK_HOURS, tashkentHour(15, 1))).not.toThrow();
  });

  it('rejects the lunch-break hour itself (13:00, between the two ranges)', () => {
    expect(() => assertBookableTime(LUNCH_BREAK_HOURS, tashkentHour(13, 1))).toThrow(BookingValidationError);
  });

  it('rejects an hour before the morning range opens', () => {
    expect(() => assertBookableTime(LUNCH_BREAK_HOURS, tashkentHour(8, 1))).toThrow(BookingValidationError);
  });

  it('rejects an hour at/after the afternoon range closes', () => {
    expect(() => assertBookableTime(LUNCH_BREAK_HOURS, tashkentHour(21, 1))).toThrow(BookingValidationError);
  });
});

describe('assertBookableTime — single-range shops (no lunch break) are unaffected', () => {
  const SINGLE_RANGE = [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], from: '09:00', to: '21:00' }];

  it('allows any hour within the single range', () => {
    expect(() => assertBookableTime(SINGLE_RANGE, tashkentHour(12, 1))).not.toThrow();
  });

  it('rejects a day with no matching schedule entry at all', () => {
    const weekdaysOnly = [{ days: ['Monday'], from: '09:00', to: '21:00' }];
    expect(() => assertBookableTime(weekdaysOnly, tashkentHour(12, 1))).toThrow(BookingValidationError);
  });
});

describe('assertBookableTime — basic guards', () => {
  const HOURS = [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], from: '09:00', to: '21:00' }];

  it('rejects a time already in the past', () => {
    expect(() => assertBookableTime(HOURS, new Date(FIXED_NOW.getTime() - 3600_000))).toThrow(BookingValidationError);
  });

  it('rejects a time not exactly on the hour', () => {
    const offHour = tashkentHour(12, 1);
    offHour.setMinutes(30);
    expect(() => assertBookableTime(HOURS, offHour)).toThrow(BookingValidationError);
  });

  it('rejects an invalid Date', () => {
    expect(() => assertBookableTime(HOURS, new Date('not a date'))).toThrow(BookingValidationError);
  });
});

describe('isWithinWorkingHours — read-only "is it open right now" check', () => {

  it('is true during either lunch-break range', () => {
    expect(isWithinWorkingHours(LUNCH_BREAK_HOURS, tashkentHour(10, 1))).toBe(true);
    expect(isWithinWorkingHours(LUNCH_BREAK_HOURS, tashkentHour(15, 1))).toBe(true);
  });

  it('is false during the lunch break itself', () => {
    expect(isWithinWorkingHours(LUNCH_BREAK_HOURS, tashkentHour(13, 1))).toBe(false);
  });
});

