// Server-side booking-time validation. The customer app already restricts
// the picker to valid slots, but the API must never trust that — a direct
// request can send anything.

export class BookingValidationError extends Error {}

// Shared by assertBookableTime below and by the read-only cross-shop
// "is this hour open" check (utils/bookingTime.js's isWithinWorkingHours,
// used by routes/shops.js's /available-now) — a single source of truth for
// "which schedule entry (if any) covers this day".
function scheduleForDay(workingHours, requestedTime) {
  const dayName = requestedTime.toLocaleDateString('en-US', { weekday: 'long' });
  return (workingHours || []).find((wh) => wh.days.includes(dayName)) || null;
}

// Pure boolean version of the day/hour check inside assertBookableTime,
// with no future/on-the-hour requirement — used where we just need "is the
// shop open at this instant", not "is this a valid slot to book".
export function isWithinWorkingHours(workingHours, requestedTime) {
  const schedule = scheduleForDay(workingHours, requestedTime);
  if (!schedule) return false;
  const [fromHour] = schedule.from.split(':').map(Number);
  const [toHour] = schedule.to.split(':').map(Number);
  const hour = requestedTime.getHours();
  return hour >= fromHour && hour < toHour;
}

// Appointments are booked in fixed 1-hour slots — this is both a scheduling
// simplification (see routes/shops.js conflict-checking) and matches how
// these shops actually work: one client occupies a barber for about an hour.
//
// Takes a plain workingHours array rather than a shop, so the same
// validator serves both a shop's blanket hours and a specific staff
// member's override (routes/shops.js resolves which one applies before
// calling this — an empty staff override falls back to the shop's).
export function assertBookableTime(workingHours, requestedTime, closedLabel = 'This shop') {
  if (!(requestedTime instanceof Date) || Number.isNaN(requestedTime.getTime())) {
    throw new BookingValidationError('Invalid requested time.');
  }

  if (requestedTime.getTime() <= Date.now()) {
    throw new BookingValidationError('That time has already passed — please pick a future slot.');
  }

  if (requestedTime.getMinutes() !== 0 || requestedTime.getSeconds() !== 0) {
    throw new BookingValidationError('Appointments can only be booked on the hour.');
  }

  const dayName = requestedTime.toLocaleDateString('en-US', { weekday: 'long' });
  const schedule = scheduleForDay(workingHours, requestedTime);
  if (!schedule) {
    throw new BookingValidationError(`${closedLabel} is closed on ${dayName}s.`);
  }

  const [fromHour] = schedule.from.split(':').map(Number);
  const [toHour] = schedule.to.split(':').map(Number);
  const hour = requestedTime.getHours();
  if (hour < fromHour || hour >= toHour) {
    throw new BookingValidationError(`${closedLabel} is only open ${schedule.from}–${schedule.to} on ${dayName}s.`);
  }
}
