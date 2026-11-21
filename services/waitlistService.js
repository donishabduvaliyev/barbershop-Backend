import WaitlistEntry from '../models/waitlistEntry.js';
import ServicesModel from '../models/shopData.js';
import { toDateKey } from '../utils/dateKey.js';
import { emitToShop, emitToUser } from '../config/socket.js';
import { notifyUser } from '../config/telegramBot.js';
import { escapeHtml } from '../utils/telegramFormat.js';
import { isValidObjectId, sanitizeString } from '../utils/validate.js';

const FINALIZED_STATUSES = ['completed', 'cancelled', 'no_show'];

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

  const shop = await ServicesModel.findById(shopId).select('name staff');
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

  // Determine trusted Telegram ID (never trust raw req.body.telegramId on public routes)
  let safeTelegramId = null;
  if (verifiedTelegramId && Number.isSafeInteger(Number(verifiedTelegramId)) && Number(verifiedTelegramId) > 0) {
    safeTelegramId = Number(verifiedTelegramId);
  } else if (allowUnverifiedTelegramId && data?.telegramId && Number.isSafeInteger(Number(data.telegramId)) && Number(data.telegramId) > 0) {
    safeTelegramId = Number(data.telegramId);
  }

  // Count currently waiting ahead
  const waitingAheadFilter = { shopId, date: today, status: 'waiting' };
  if (data.staffId) {
    waitingAheadFilter.staffId = data.staffId;
  }
  const waitingAhead = await WaitlistEntry.countDocuments(waitingAheadFilter);
  const estimatedWaitMinutes = Math.max(10, waitingAhead * 20);

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
        serviceName: sanitizeString(data.serviceName, 150),
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
      `👥 Oldingizda: <b>${waitingAhead} kishi</b>`;
    notifyUser(entry.telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
  }

  return { entry, positionAhead: waitingAhead };
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
    // Strip PII (customerPhone, telegramId, notes) from unauthenticated responses
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

  emitToShop(shopId, 'waitlist:update', { action: nextStatus, entry });
  if (entry.telegramId && entry.telegramId > 0) {
    emitToUser(entry.telegramId, 'waitlist:status', { status: nextStatus, entry });
  }

  if (nextStatus === 'called' && entry.telegramId && entry.telegramId > 0) {
    const shop = await ServicesModel.findById(shopId).select('name');
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
