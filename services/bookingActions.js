// Single source of truth for what happens when a booking is confirmed,
// rejected, or completed — called identically by the shop-control bot's
// inline-button callbacks and the admin panel's REST endpoints, so the two
// entry points can never drift out of sync.
import Booking from '../models/bookingHistory.js';
import { notifyUser, sendRatingRequest } from '../config/telegramBot.js';
import { editBookingCard } from '../config/notificationBridge.js';
import { emitToShop } from '../config/socket.js';
import { DIVIDER, formatDateTime } from '../utils/telegramFormat.js';
import { t, normalizeLanguage } from '../utils/botMessages.js';

// A booking that's already left the 'pending' state has already been acted
// on once (by the bot or the panel) — treat re-triggering as a no-op rather
// than re-sending notifications or overwriting a later status.
export async function confirmBooking(bookingId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;
  if (booking.status !== 'pending') return booking;

  booking.status = 'confirmed';
  await booking.save();
  console.log(`✅ Booking ${booking._id} confirmed — ${booking.shopName}, ${booking.userName} @ ${booking.requestedTime.toISOString()}`);

  const userLang = normalizeLanguage(booking.userLanguage);
  const userMessage = [
    t(userLang, 'customer.bookingConfirmedTitle'),
    DIVIDER,
    t(userLang, 'customer.bookingConfirmedBody', { shopName: booking.shopName, dateTime: formatDateTime(booking.requestedTime, userLang) }),
    '',
    t(userLang, 'customer.seeYouThere'),
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusConfirmed'));
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
  console.log(`❌ Booking ${booking._id} rejected — ${booking.shopName}, ${booking.userName} @ ${booking.requestedTime.toISOString()} (reason: ${reason})`);

  const userLang = normalizeLanguage(booking.userLanguage);
  const userMessage = [
    t(userLang, 'customer.bookingUpdateTitle'),
    DIVIDER,
    t(userLang, 'customer.bookingRejectedBody', { shopName: booking.shopName, dateTime: formatDateTime(booking.requestedTime, userLang) }),
    '',
    t(userLang, 'customer.reasonLabel', { reason }),
    '',
    t(userLang, 'customer.pickAnotherTime'),
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusRejected', { reason }));
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
  console.log(`🏁 Booking ${booking._id} marked completed — ${booking.shopName}, ${booking.userName}`);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusCompleted'));
  emitToShop(booking.shopId, 'appointment:update', booking);

  if (!booking.ratingRequested) {
    await sendRatingRequest(booking);
    booking.ratingRequested = true;
    await booking.save();
  }

  return booking;
}

// The reminder sweep auto-completes a confirmed booking as soon as its time
// passes, with no way to know whether the customer actually came — this is
// the owner correcting that after the fact from the Appointments page, so
// it's allowed from either 'confirmed' (caught before the sweep ran) or
// 'completed' (caught after). No customer notification — they already know
// they didn't show up.
export async function markNoShow(bookingId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;
  if (!['confirmed', 'completed'].includes(booking.status)) return booking;

  booking.status = 'no-show';
  await booking.save();
  console.log(`🚫 Booking ${booking._id} marked no-show — ${booking.shopName}, ${booking.userName}`);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusNoShow'));
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}
