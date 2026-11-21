import WaitlistEntry from '../models/waitlistEntry.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { toDateKey } from '../utils/dateKey.js';
import { emitToShop, emitToUser } from '../config/socket.js';
import { notifyUser } from '../config/telegramBot.js';
import { escapeHtml } from '../utils/telegramFormat.js';
import { isValidObjectId, sanitizeString } from '../utils/validate.js';
import { generateSyntheticTelegramId } from '../utils/syntheticCustomerId.js';

const FINALIZED_STATUSES = ['completed', 'cancelled', 'no_show'];

/**
 * Computes unified wait estimate factoring in BOTH live walk-in queue
 * AND upcoming scheduled bookings in the next 2 hours.
 */
export async function calculateUnifiedWaitEstimate(shop, staffId = null) {
  const today = toDateKey(new Date());
  const now = new Date();
  const currentHourStart = new Date(now);
  currentHourStart.setMinutes(0, 0, 0);
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const waitlistFilter = {
    shopId: shop._id,
    date: today,
    status: { $in: ['waiting', 'called'] },
  };
  const bookingFilter = {
    shopId: shop._id,
    status: { $in: ['pending', 'confirmed'] },
    requestedTime: { $gte: currentHourStart, $lte: twoHoursLater },
  };

  if (staffId) {
    waitlistFilter.staffId = staffId;
    bookingFilter.staffId = staffId;
  }

  const [waitingCount, upcomingBookingsCount] = await Promise.all([
    WaitlistEntry.countDocuments(waitlistFilter),
    Booking.countDocuments(bookingFilter),
  ]);

  const capacity = staffId ? 1 : Math.max(1, shop.staff?.length || shop.capacity || 1);
  const totalLoad = waitingCount + upcomingBookingsCount;
  const estimatedWaitMinutes = Math.max(10, Math.round((totalLoad / capacity) * 25));

  return {
    waitingCount,
    upcomingBookingsCount,
    estimatedWaitMinutes,
    capacity,
  };
}

/**
 * Public summary for Reception QR Self Check-In page (/waitlist/:shopId).
 */
export async function getPublicWaitlistSummary(shopId) {
  if (!isValidObjectId(shopId)) {
    const err = new Error('Invalid shopId');
    err.statusCode = 400;
    throw err;
  }

  const shop = await ServicesModel.findOne({ _id: shopId, isArchived: { $ne: true } })
    .select('name address phone image staff services capacity isOperational');
  if (!shop) {
    const err = new Error('Shop not found');
    err.statusCode = 404;
    throw err;
  }

  const estimate = await calculateUnifiedWaitEstimate(shop);

  return {
    shop: {
      _id: shop._id,
      name: shop.name,
      address: shop.address,
      phone: shop.phone,
      image: shop.image,
      isOperational: shop.isOperational,
      staff: (shop.staff || []).map((s) => ({
        _id: s._id,
        name: s.name,
        title: s.title,
        photo: s.photo,
        isAvailableNow: s.isAvailableNow !== false,
      })),
      services: (shop.services || []).filter((sv) => sv.isActive !== false),
    },
    ...estimate,
  };
}

/**
 * Synchronizes a walk-in queue entry into BookingData (source: 'walk-in')
 * so occupied chairs block online slots and completed walk-ins feed
 * Dashboard Stats, Staff Payroll & Commissions, and Customer CRM.
 */
async function syncWalkInToBooking(entry, shop, targetStatus) {
  if (entry.bookingId) {
    const existing = await Booking.findByIdAndUpdate(
      entry.bookingId,
      { $set: { status: targetStatus } },
      { new: true }
    );
    if (existing) {
      emitToShop(shop._id, 'appointment:update', existing);
      return existing;
    }
  }

  if (targetStatus !== 'confirmed' && targetStatus !== 'completed') {
    return null;
  }

  const requestedTime = new Date();
  requestedTime.setMinutes(0, 0, 0);

  const shopDisplayName = shop?.name?.en || shop?.name?.uz || shop?.name?.ru || 'Salon';
  const userTelegramId = entry.telegramId && entry.telegramId > 0
    ? entry.telegramId
    : generateSyntheticTelegramId();

  const bookingDoc = {
    shopId: shop._id,
    shopName: shopDisplayName,
    userTelegramId,
    userName: entry.customerName,
    userNumber: entry.customerPhone,
    requestedTime,
    status: targetStatus,
    staffId: entry.staffId || null,
    staffName: entry.staffName || '',
    serviceId: entry.serviceId || null,
    serviceName: entry.serviceName || '',
    price: typeof entry.price === 'number' ? entry.price : null,
    source: 'walk-in',
    notes: entry.notes || '',
  };

  let created = null;
  try {
    created = await Booking.create(bookingDoc);
  } catch (err) {
    // If a confirmed booking already occupies that exact staff+hour index,
    // fall back to virtualSlot so the walk-in record is still logged cleanly.
    if (err.code === 11000) {
      bookingDoc.staffId = null;
      bookingDoc.virtualSlot = Math.floor(Math.random() * 1000) + 10;
      created = await Booking.create(bookingDoc);
    } else {
      throw err;
    }
  }

  entry.bookingId = created._id;
  await entry.save();

  emitToShop(shop._id, 'appointment:update', created);
  return created;
}

export async function addToWaitlist(shopId, data, { verifiedTelegramId = null, allowUnverifiedTelegramId = false } = {}) {
  if (!isValidObjectId(shopId)) {
    const err = new Error('Invalid shopId');
    err.statusCode = 400;
    throw err;
  }

  const customerName = sanitizeString(data?.customerName, 120);
  const customerPhone = sanitizeString(data?.customerPhone, 30);

  if (!customerName || !customerPhone) {
    const err = new Error('customerName and customerPhone are required');
    err.statusCode = 400;
    throw err;
  }

  if (data?.staffId && !isValidObjectId(data.staffId)) {
    const err = new Error('Invalid staffId');
    err.statusCode = 400;
    throw err;
  }

  if (data?.serviceId && !isValidObjectId(data.serviceId)) {
    const err = new Error('Invalid serviceId');
    err.statusCode = 400;
    throw err;
  }

  const shop = await ServicesModel.findById(shopId).select('name staff services capacity');
  if (!shop) {
    const err = new Error('Shop not found');
    err.statusCode = 404;
    throw err;
  }

  const today = toDateKey(new Date());

  let staffName = '';
  if (data.staffId) {
    const staffMember = (shop.staff || []).find((s) => String(s._id) === String(data.staffId));
    staffName = staffMember ? staffMember.name : sanitizeString(data.staffName, 120);
  }

  let resolvedServiceId = data.serviceId || null;
  let resolvedServiceName = sanitizeString(data.serviceName, 150);
  let resolvedPrice = typeof data.price === 'number' && Number.isFinite(data.price) && data.price >= 0 ? data.price : null;

  if (resolvedServiceId) {
    const matchedSv = (shop.services || []).find((sv) => String(sv._id) === String(resolvedServiceId));
    if (matchedSv) {
      resolvedServiceName = resolvedServiceName || matchedSv.name?.uz || matchedSv.name?.en || matchedSv.name?.ru || '';
      if (resolvedPrice === null) resolvedPrice = matchedSv.price;
    }
  } else if (resolvedServiceName) {
    const matchedSv = (shop.services || []).find(
      (sv) =>
        sv.name?.uz === resolvedServiceName ||
        sv.name?.en === resolvedServiceName ||
        sv.name?.ru === resolvedServiceName
    );
    if (matchedSv) {
      resolvedServiceId = matchedSv._id;
      if (resolvedPrice === null) resolvedPrice = matchedSv.price;
    }
  }

  // Determine trusted Telegram ID (never trust raw req.body.telegramId on public routes)
  let safeTelegramId = null;
  if (verifiedTelegramId && Number.isSafeInteger(Number(verifiedTelegramId)) && Number(verifiedTelegramId) > 0) {
    safeTelegramId = Number(verifiedTelegramId);
  } else if (allowUnverifiedTelegramId && data?.telegramId && Number.isSafeInteger(Number(data.telegramId)) && Number(data.telegramId) > 0) {
    safeTelegramId = Number(data.telegramId);
  }

  // Unified wait estimation (live queue + scheduled bookings in next 2 hours)
  const { waitingCount, upcomingBookingsCount, estimatedWaitMinutes } = await calculateUnifiedWaitEstimate(
    shop,
    data.staffId || null
  );

  // Assign daily sequential queueNumber with race-condition retry
  let entry = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = await WaitlistEntry.findOne({ shopId, date: today })
      .sort({ queueNumber: -1 })
      .select('queueNumber');
    const nextNum = (latest?.queueNumber || 0) + 1;

    try {
      entry = await WaitlistEntry.create({
        shopId,
        queueNumber: nextNum,
        date: today,
        customerName,
        customerPhone,
        telegramId: safeTelegramId,
        staffId: data.staffId || null,
        staffName,
        serviceId: resolvedServiceId,
        serviceName: resolvedServiceName,
        price: resolvedPrice,
        estimatedWaitMinutes,
        status: 'waiting',
        notes: sanitizeString(data.notes, 300),
      });
      break;
    } catch (err) {
      if (err.code === 11000 && attempt < 4) {
        continue;
      }
      throw err;
    }
  }

  emitToShop(shopId, 'waitlist:update', { action: 'joined', entry });

  if (entry.telegramId && entry.telegramId > 0) {
    const shopLabel = escapeHtml(shop.name?.uz || shop.name?.en || 'Salon');
    const msg =
      `🎟 <b>Navbat raqamingiz: #${entry.queueNumber}</b>\n\n` +
      `🏪 <b>${shopLabel}</b>\n` +
      `⏳ Taxminiy kutish vaqti: <b>~${entry.estimatedWaitMinutes} daqiqa</b>\n` +
      `👥 Oldingizda: <b>${waitingCount} kishi</b>`;
    notifyUser(entry.telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
  }

  return { entry, positionAhead: waitingCount, upcomingBookingsCount };
}

export async function getShopQueue(shopId, date = toDateKey(new Date())) {
  if (!isValidObjectId(shopId)) {
    const err = new Error('Invalid shopId');
    err.statusCode = 400;
    throw err;
  }

  const active = await WaitlistEntry.find({
    shopId,
    date,
    status: { $in: ['waiting', 'called', 'in_chair'] },
  }).sort({ queueNumber: 1 });

  return active;
}

export async function getEntryPosition(shopId, entryId, { publicView = false } = {}) {
  if (!isValidObjectId(shopId) || !isValidObjectId(entryId)) {
    const err = new Error('Invalid shopId or entryId');
    err.statusCode = 400;
    throw err;
  }

  const entry = await WaitlistEntry.findOne({ _id: entryId, shopId });
  if (!entry) {
    const err = new Error('Waitlist entry not found');
    err.statusCode = 404;
    throw err;
  }

  let aheadCount = 0;
  if (entry.status === 'waiting') {
    aheadCount = await WaitlistEntry.countDocuments({
      shopId,
      date: entry.date,
      status: 'waiting',
      queueNumber: { $lt: entry.queueNumber },
    });
  }

  if (publicView) {
    return {
      entry: {
        _id: entry._id,
        shopId: entry.shopId,
        queueNumber: entry.queueNumber,
        date: entry.date,
        status: entry.status,
        estimatedWaitMinutes: entry.estimatedWaitMinutes,
        staffName: entry.staffName,
        serviceName: entry.serviceName,
        joinedAt: entry.joinedAt,
      },
      positionAhead: aheadCount,
    };
  }

  return { entry, positionAhead: aheadCount };
}

export async function updateWaitlistStatus(shopId, entryId, nextStatus) {
  if (!isValidObjectId(shopId) || !isValidObjectId(entryId)) {
    const err = new Error('Invalid shopId or entryId');
    err.statusCode = 400;
    throw err;
  }

  const entry = await WaitlistEntry.findOne({ _id: entryId, shopId });
  if (!entry) {
    const err = new Error('Waitlist entry not found');
    err.statusCode = 404;
    throw err;
  }

  if (FINALIZED_STATUSES.includes(entry.status)) {
    const err = new Error(`Cannot change status of an already ${entry.status} waitlist entry`);
    err.statusCode = 400;
    throw err;
  }

  entry.status = nextStatus;
  if (nextStatus === 'called') entry.calledAt = new Date();
  if (nextStatus === 'in_chair') entry.seatedAt = new Date();
  if (nextStatus === 'completed') entry.completedAt = new Date();

  await entry.save();

  const shop = await ServicesModel.findById(shopId).select('name');

  // Synchronize with BookingData so appointments, availability, stats, payroll & CRM stay 100% unified
  if (shop) {
    if (nextStatus === 'in_chair') {
      await syncWalkInToBooking(entry, shop, 'confirmed');
    } else if (nextStatus === 'completed') {
      await syncWalkInToBooking(entry, shop, 'completed');
    } else if (nextStatus === 'cancelled' || nextStatus === 'no_show') {
      await syncWalkInToBooking(entry, shop, 'cancelled');
    }
  }

  emitToShop(shopId, 'waitlist:update', { action: nextStatus, entry });
  if (entry.telegramId && entry.telegramId > 0) {
    emitToUser(entry.telegramId, 'waitlist:status', { status: nextStatus, entry });
  }

  if (nextStatus === 'called' && entry.telegramId && entry.telegramId > 0) {
    const shopLabel = escapeHtml(shop?.name?.uz || shop?.name?.en || 'Salon');
    const msg =
      `🪑 <b>Navbatingiz keldi! (#${entry.queueNumber})</b>\n\n` +
      `🏪 <b>${shopLabel}</b>\n` +
      `💇 Usta: <b>${escapeHtml(entry.staffName || 'Bo‘sh usta')}</b>\n` +
      `Iltimos, zalga kiring!`;
    notifyUser(entry.telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
  }

  return entry;
}
