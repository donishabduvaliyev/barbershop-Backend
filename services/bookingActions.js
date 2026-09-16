// Single source of truth for what happens when a booking is confirmed,
// rejected, or completed — called identically by the shop-control bot's
// inline-button callbacks and the admin panel's REST endpoints, so the two
// entry points can never drift out of sync.
import Booking from '../models/bookingHistory.js';
import ServicesModel from '../models/shopData.js';
import { notifyUser, sendRatingRequest } from '../config/telegramBot.js';
import { editBookingCard } from '../config/notificationBridge.js';
import { emitToShop } from '../config/socket.js';
import { DIVIDER, formatDateTime } from '../utils/telegramFormat.js';
import { t, normalizeLanguage } from '../utils/botMessages.js';
import { escapeMarkdown } from '../utils/escapeMarkdown.js';
import { assertBookableTime, BookingValidationError } from '../utils/bookingTime.js';
import { toDateKey } from '../utils/dateKey.js';
import { BookingConflictError } from './createBooking.js';

// A booking that's already left the 'pending' state has already been acted
// on once (by the bot or the panel) — treat re-triggering as a no-op rather
// than re-sending notifications or overwriting a later status.
//
// The status check-and-set is one atomic findOneAndUpdate, not a separate
// findById + save — a plain read-then-write left a real race where two
// rapid taps on the same Confirm/Reject button (or a tap racing the
// reminder sweep's auto-complete) could both pass the in-app status check
// before either write landed, sending the customer two contradictory
// notifications and double-editing the owner's card.
export async function confirmBooking(bookingId) {
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, status: 'pending' },
    { $set: { status: 'confirmed' } },
    { new: true }
  );
  if (!booking) return Booking.findById(bookingId);
  console.log(`✅ Booking ${booking._id} confirmed — ${booking.shopName}, ${booking.userName} @ ${booking.requestedTime.toISOString()}`);

  const userLang = normalizeLanguage(booking.userLanguage);
  const userMessage = [
    t(userLang, 'customer.bookingConfirmedTitle'),
    DIVIDER,
    t(userLang, 'customer.bookingConfirmedBody', { shopName: escapeMarkdown(booking.shopName), dateTime: formatDateTime(booking.requestedTime, userLang) }),
    '',
    t(userLang, 'customer.seeYouThere'),
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusConfirmed'));
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}

export async function rejectBooking(bookingId, reason) {
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, status: { $in: ['pending', 'confirmed'] } },
    { $set: { status: 'rejected', rejectionReason: reason } },
    { new: true }
  );
  if (!booking) return Booking.findById(bookingId);
  console.log(`❌ Booking ${booking._id} rejected — ${booking.shopName}, ${booking.userName} @ ${booking.requestedTime.toISOString()} (reason: ${reason})`);

  const userLang = normalizeLanguage(booking.userLanguage);
  const userMessage = [
    t(userLang, 'customer.bookingUpdateTitle'),
    DIVIDER,
    t(userLang, 'customer.bookingRejectedBody', { shopName: escapeMarkdown(booking.shopName), dateTime: formatDateTime(booking.requestedTime, userLang) }),
    '',
    t(userLang, 'customer.reasonLabel', { reason: escapeMarkdown(reason) }),
    '',
    t(userLang, 'customer.pickAnotherTime'),
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusRejected', { reason: escapeMarkdown(reason) }));
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}

// Marks a confirmed booking as completed and kicks off the rating request —
// used both by the reminder sweep (jobs/reminders.js, once the slot time has
// passed) and the admin panel ("mark as completed" action).
export async function completeBooking(bookingId) {
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, status: 'confirmed' },
    { $set: { status: 'completed' } },
    { new: true }
  );
  if (!booking) return Booking.findById(bookingId);
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
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, status: { $in: ['confirmed', 'completed'] } },
    { $set: { status: 'no-show' } },
    { new: true }
  );
  if (!booking) return Booking.findById(bookingId);
  console.log(`🚫 Booking ${booking._id} marked no-show — ${booking.shopName}, ${booking.userName}`);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusNoShow'));
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}

// Distinct from rejectBooking: reject is for the pending stage ("we
// couldn't confirm this"); cancel is the owner calling off something
// already confirmed. Reason is optional here (often just a scheduling
// change on the shop's end, not something that needs explaining the way a
// rejection does).
export async function cancelBooking(bookingId, reason) {
  const update = { status: 'cancelled' };
  if (reason) update.rejectionReason = reason;
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, status: { $in: ['pending', 'confirmed'] } },
    { $set: update },
    { new: true }
  );
  if (!booking) return Booking.findById(bookingId);
  console.log(`🗑️ Booking ${booking._id} cancelled — ${booking.shopName}, ${booking.userName}${reason ? ` (reason: ${reason})` : ''}`);

  const userLang = normalizeLanguage(booking.userLanguage);
  const userMessage = [
    t(userLang, 'customer.bookingUpdateTitle'),
    DIVIDER,
    t(userLang, 'customer.bookingCancelledBody', { shopName: escapeMarkdown(booking.shopName), dateTime: formatDateTime(booking.requestedTime, userLang) }),
    ...(reason ? ['', t(userLang, 'customer.reasonLabel', { reason: escapeMarkdown(reason) })] : []),
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusCancelled'));
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}

// Reschedule keeps the same customer/staff/service, just moves the time —
// reruns the same working-hours/days-off/conflict checks a fresh booking
// would for that staff member (or shop, if staffless), via the shared
// utils/bookingTime.js validator, so a rescheduled slot can never end up
// less valid than a newly-created one would be. Throws
// BookingValidationError/BookingConflictError the same way createBooking
// does — the route maps those to 400/409.
export async function rescheduleBooking(bookingId, newRequestedTime) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;

  const shop = await ServicesModel.findById(booking.shopId).select('staff workingHours');
  const staffMember = booking.staffId ? shop?.staff?.id(booking.staffId) : null;
  const newDateKey = toDateKey(newRequestedTime);

  if (staffMember?.daysOff?.includes(newDateKey)) {
    throw new BookingValidationError(`${staffMember.name} is off that day — please pick another date.`);
  }
  const effectiveWorkingHours = staffMember?.workingHours?.length ? staffMember.workingHours : shop?.workingHours;
  assertBookableTime(effectiveWorkingHours, newRequestedTime, staffMember?.name || booking.shopName || 'This shop');

  const oldTime = booking.requestedTime;
  booking.requestedTime = newRequestedTime;
  try {
    await booking.save();
  } catch (err) {
    if (err.code === 11000) {
      throw new BookingConflictError('That time is already taken — please pick another slot.');
    }
    throw err;
  }
  console.log(`🔁 Booking ${booking._id} rescheduled — ${booking.shopName}, ${booking.userName} from ${oldTime.toISOString()} to ${newRequestedTime.toISOString()}`);

  const userLang = normalizeLanguage(booking.userLanguage);
  const userMessage = [
    t(userLang, 'customer.bookingUpdateTitle'),
    DIVIDER,
    t(userLang, 'customer.bookingRescheduledBody', { shopName: escapeMarkdown(booking.shopName), dateTime: formatDateTime(booking.requestedTime, userLang) }),
  ].join('\n');
  await notifyUser(booking.userTelegramId, userMessage);
  await editBookingCard(booking, t(normalizeLanguage(booking.ownerLanguage), 'owner.statusRescheduled', { dateTime: formatDateTime(booking.requestedTime, normalizeLanguage(booking.ownerLanguage)) }));
  emitToShop(booking.shopId, 'appointment:update', booking);

  return booking;
}
