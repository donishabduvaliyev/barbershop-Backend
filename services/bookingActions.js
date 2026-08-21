// Single source of truth for what happens when a booking is confirmed,
// rejected, or completed — called identically by the shop-control bot's
// inline-button callbacks and the admin panel's REST endpoints, so the two
// entry points can never drift out of sync.
import Booking from '../models/bookingHistory.js';
import { notifyUser, sendRatingRequest } from '../config/telegramBot.js';
import { editBookingCard } from '../config/notificationBridge.js';
import { emitToShop } from '../config/socket.js';
import { DIVIDER, formatDateTime } from '../utils/telegramFormat.js';

// A booking that's already left the 'pending' state has already been acted
// on once (by the bot or the panel) — treat re-triggering as a no-op rather
// than re-sending notifications or overwriting a later status.
export async function confirmBooking(bookingId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;
  if (booking.status !== 'pending') return booking;

  booking.status = 'confirmed';
  await booking.save();

  const userMessage = [
    '✅ *Booking Confirmed*',
    DIVIDER,
    `Your appointment at *${booking.shopName}* is set for 🗓 ${formatDateTime(booking.requestedTime)}.`,
    '',
    'See you there! 💈',
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, '🟢 *CONFIRMED*');
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}

export async function rejectBooking(bookingId, reason) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;
  if (!['pending', 'confirmed'].includes(booking.status)) return booking;

  booking.status = 'rejected';
  booking.rejectionReason = reason;
  await booking.save();

  const userMessage = [
    '❌ *Booking Update*',
    DIVIDER,
    `We couldn't confirm your booking at *${booking.shopName}* for 🗓 ${formatDateTime(booking.requestedTime)}.`,
    '',
    `*Reason:* ${reason}`,
    '',
    'Feel free to pick another time that works for you.',
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, `🔴 *REJECTED*\n*Reason:* ${reason}`);
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}

// Marks a confirmed booking as completed and kicks off the rating request —
// used both by the reminder sweep (jobs/reminders.js, once the slot time has
// passed) and the admin panel ("mark as completed" action).
export async function completeBooking(bookingId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;
  if (booking.status !== 'confirmed') return booking;

  booking.status = 'completed';
  await booking.save();
  await editBookingCard(booking, '✅ *COMPLETED*');
  emitToShop(booking.shopId, 'appointment:update', booking);

  if (!booking.ratingRequested) {
    await sendRatingRequest(booking);
    booking.ratingRequested = true;
    await booking.save();
  }

  return booking;
}
