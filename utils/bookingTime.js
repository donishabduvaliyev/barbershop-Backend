// Server-side booking-time validation. The customer app already restricts
// the picker to valid slots, but the API must never trust that — a direct
// request can send anything.

export class BookingValidationError extends Error {}

// Appointments are booked in fixed 1-hour slots — this is both a scheduling
// simplification (see routes/shops.js conflict-checking) and matches how
// these shops actually work: one client occupies a barber for about an hour.
export function assertBookableTime(shop, requestedTime) {
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
  const schedule = (shop.workingHours || []).find((wh) => wh.days.includes(dayName));
  if (!schedule) {
    throw new BookingValidationError(`This shop is closed on ${dayName}s.`);
  }

  const [fromHour] = schedule.from.split(':').map(Number);
  const [toHour] = schedule.to.split(':').map(Number);
  const hour = requestedTime.getHours();
  if (hour < fromHour || hour >= toHour) {
    throw new BookingValidationError(`This shop is only open ${schedule.from}–${schedule.to} on ${dayName}s.`);
  }
}
