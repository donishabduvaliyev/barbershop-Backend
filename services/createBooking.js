import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Customer from '../models/customer.js';
import { assertBookableTime, BookingValidationError } from '../utils/bookingTime.js';
import { toDateKey } from '../utils/dateKey.js';

export class BookingConflictError extends Error {}
export class BookingNotFoundError extends Error {}

const ACTIVE_STATUSES = ['pending', 'confirmed'];

// Atomically claims one "any available" slot the same way the staffId
// unique index does for a specific barber. Tries virtualSlot 0, 1, 2… up to
// capacity - 1, relying on the partial unique index on {shopId,
// requestedTime, virtualSlot} to reject a slot number another concurrent
// request just took.
async function claimVirtualSlot(bookingDoc, capacity) {
  for (let slot = 0; slot < capacity; slot++) {
    bookingDoc.virtualSlot = slot;
    try {
      await bookingDoc.save();
      return true;
    } catch (err) {
      if (err.code !== 11000) throw err;
      bookingDoc.isNew = true; // retry the same in-memory doc with the next slot
    }
  }
  return false;
}

// Shared by the customer-facing POST /booking-requests (routes/shops.js)
// and the admin panel's manual-booking endpoint (routes/adminAppointments.js)
// — the exact same staff/service/working-hours/capacity rules must apply
// whether a booking comes from a customer via Telegram or an owner typing
// one in for a walk-in/phone call, so this is the one place that logic
// lives. Throws BookingValidationError (→ 400), BookingConflictError
// (→ 409), or BookingNotFoundError (→ 404) — callers map these to HTTP
// responses; anything else is a genuine server error.
export async function createBooking({
  shopId, requestedTime, staffId, serviceId,
  userTelegramId, userTelegramUsername = '', userNumber, userTelegramNumber = '', userName,
  userLanguage = 'uz', shopName, source = 'bot',
  checkShopOperational = true,
}) {
  const shop = await ServicesModel.findById(shopId).select('name staff services workingHours isOperational capacity');
  if (!shop) throw new BookingNotFoundError('Shop not found.');
  // Only gates customer-initiated online booking — an owner manually
  // recording someone already standing in the shop isn't affected by this.
  if (checkShopOperational && !shop.isOperational) {
    throw new BookingConflictError('This shop is not currently accepting bookings.');
  }

  // Applies uniformly to a customer-app booking and an owner's own manual
  // entry alike — if the owner wants to override for a specific walk-in,
  // unblocking first is the one, explicit way to do that, rather than a
  // hidden bypass on this one code path.
  const existingCustomer = await Customer.findOne({ shopId, telegramId: userTelegramId }).select('isBlocked');
  if (existingCustomer?.isBlocked) {
    throw new BookingConflictError('This customer is currently blocked from booking at this shop.');
  }

  const requestedTimeDate = new Date(requestedTime);
  const requestedDateKey = toDateKey(requestedTimeDate);
  const isToday = requestedDateKey === toDateKey(new Date());

  // A staffId/serviceId is only ever honored if it actually belongs to this
  // shop — never trust a client-supplied name/price alongside it. Resolved
  // before the working-hours check, since a specific staff member's own
  // hours (if set) take precedence over the shop's blanket hours.
  let resolvedStaffMember = null;
  if (staffId) {
    const staffMember = shop.staff?.id(staffId);
    if (staffMember) {
      if (staffMember.daysOff?.includes(requestedDateKey)) {
        throw new BookingValidationError(`${staffMember.name} is off that day — please pick another date or barber.`);
      }
      // isAvailableNow is a live "is he here right now" status, only
      // consulted for today — see models/shopData.js's comment.
      if (isToday && staffMember.isAvailableNow === false) {
        throw new BookingValidationError(`${staffMember.name} isn't available right now.`);
      }
      resolvedStaffMember = staffMember;
    }
  }
  const resolvedStaffId = resolvedStaffMember?._id || null;
  const resolvedStaffName = resolvedStaffMember?.name || '';

  const effectiveWorkingHours = resolvedStaffMember?.workingHours?.length
    ? resolvedStaffMember.workingHours
    : shop.workingHours;
  assertBookableTime(effectiveWorkingHours, requestedTimeDate, resolvedStaffName || 'This shop');

  // A customer (or, for a manual booking, the same walk-in customer) can't
  // be in two places at once.
  const selfConflict = await Booking.exists({
    userTelegramId, requestedTime: requestedTimeDate, status: { $in: ACTIVE_STATUSES },
  });
  if (selfConflict) {
    throw new BookingConflictError('This customer already has another appointment booked at this time.');
  }

  // serviceId is optional — when present it must be real and active; when
  // absent we just skip attaching service/price info instead of failing.
  let resolvedService = null;
  if (serviceId) {
    resolvedService = shop.services?.id(serviceId);
    if (!resolvedService || resolvedService.isActive === false) {
      throw new BookingValidationError('Selected service is no longer available.');
    }
  }

  // A staff member restricted to specific services (serviceIds non-empty)
  // can't be booked for anything outside that list.
  if (resolvedStaffMember && resolvedService && resolvedStaffMember.serviceIds?.length > 0) {
    const performsIt = resolvedStaffMember.serviceIds.some((id) => id.toString() === resolvedService._id.toString());
    if (!performsIt) {
      throw new BookingValidationError(`${resolvedStaffMember.name} doesn't offer this service — please pick another barber or service.`);
    }
  }

  const serviceName = resolvedService
    ? (resolvedService.name?.[userLanguage] || resolvedService.name?.en || resolvedService.name?.ru || resolvedService.name?.uz || '')
    : '';

  const baseFields = {
    shopId,
    shopName: shopName || shop.name?.en || '',
    userTelegramId,
    userTelegramUsername,
    requestedTime: requestedTimeDate,
    userNumber,
    userTelegramNumber,
    userName,
    serviceId: resolvedService?._id || null,
    serviceName,
    price: resolvedService?.price ?? null,
    status: 'pending',
    userLanguage,
    source,
  };

  let booking;
  if (resolvedStaffId) {
    // A specific barber was requested — the partial unique index on
    // {shopId, staffId, requestedTime} is what actually prevents two
    // people booking the same barber/slot at once.
    booking = new Booking({ ...baseFields, staffId: resolvedStaffId, staffName: resolvedStaffName });
    try {
      await booking.save();
    } catch (err) {
      if (err.code === 11000) {
        throw new BookingConflictError('That barber was just booked for this time — please pick another slot.');
      }
      throw err;
    }
  } else {
    // "Any available" — capacity is however many staff are named, not off
    // that day, actually available right now (if today), and (if a service
    // was picked) actually perform it — or the shop's plain capacity number
    // for shops that don't track individual staff.
    const qualifiedStaff = (shop.staff || []).filter((s) => {
      if (s.daysOff?.includes(requestedDateKey)) return false;
      if (isToday && s.isAvailableNow === false) return false;
      if (resolvedService && s.serviceIds?.length > 0) {
        return s.serviceIds.some((id) => id.toString() === resolvedService._id.toString());
      }
      return true;
    });
    const capacity = shop.staff?.length > 0 ? qualifiedStaff.length : (shop.capacity || 1);
    if (capacity === 0) {
      throw new BookingConflictError('No staff can perform this on that date — please pick another date or service.');
    }
    booking = new Booking({ ...baseFields, staffId: null, staffName: '' });
    const claimed = await claimVirtualSlot(booking, capacity);
    if (!claimed) {
      throw new BookingConflictError('This time slot is fully booked — please pick another.');
    }
  }

  // Keeps the real, editable Customer record fresh every time this
  // Telegram identity books — including a synthetic negative id from a
  // walk-in created via the admin panel. Best-effort: a failure here must
  // never undo an already-saved booking.
  Customer.findOneAndUpdate(
    { shopId, telegramId: userTelegramId },
    { $set: { name: userName || undefined, number: userNumber || undefined } },
    { upsert: true, setDefaultsOnInsert: true }
  ).catch((err) => console.error('Failed to upsert customer record:', err));

  return booking;
}
