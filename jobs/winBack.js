import mongoose from 'mongoose';
import Booking from '../models/bookingHistory.js';
import ServicesModel from '../models/shopData.js';
import CustomerNote from '../models/customerNote.js';
import JobLock from '../models/jobLock.js';
import User from '../models/userdata.js';
import { notifyUser, webAppUrl } from '../config/telegramBot.js';
import { t, normalizeLanguage } from '../utils/botMessages.js';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const LOCK_ID = 'winBackSweep';

// A customer is "due" once their last completed visit is 28-35 days back —
// old enough that they're genuinely lapsed, but not so old the shop has
// missed the window where a nudge is still likely to land.
const MIN_DAYS = 28;
const MAX_DAYS = 35;

async function acquireLock(durationMs) {
  const now = new Date();
  try {
    await JobLock.findOneAndUpdate(
      { _id: LOCK_ID, lockedUntil: { $lt: now } },
      { $set: { lockedUntil: new Date(now.getTime() + durationMs) } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    console.error('Win-back job lock acquisition failed:', err);
    return false;
  }
}

// Exported separately from the interval wrapper so tests can call it
// directly instead of waiting hours for a real sweep to fire.
export async function runWinBackSweep() {
  const gotLock = await acquireLock(CHECK_INTERVAL_MS);
  if (!gotLock) return;

  const shops = await ServicesModel.find({ winBackEnabled: true }).select('_id name');

  for (const shop of shops) {
    try {
      await winBackShop(shop);
    } catch (err) {
      console.error(`Win-back sweep failed for shop ${shop._id}:`, err);
    }
  }
}

async function winBackShop(shop) {
  const now = Date.now();
  const windowStart = new Date(now - MAX_DAYS * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now - MIN_DAYS * 24 * 60 * 60 * 1000);

  const lapsed = await Booking.aggregate([
    { $match: { shopId: new mongoose.Types.ObjectId(shop._id), status: 'completed' } },
    { $sort: { requestedTime: -1 } },
    {
      $group: {
        _id: '$userTelegramId',
        lastVisit: { $first: '$requestedTime' },
      },
    },
    { $match: { lastVisit: { $gte: windowStart, $lte: windowEnd } } },
  ]);

  if (lapsed.length === 0) return;

  const notes = await CustomerNote.find({
    shopId: shop._id,
    userTelegramId: { $in: lapsed.map((c) => c._id) },
  }).select('userTelegramId lastWinBackSentAt');
  const lastSentByTelegramId = new Map(notes.map((n) => [n.userTelegramId, n.lastWinBackSentAt]));

  for (const customer of lapsed) {
    const lastSent = lastSentByTelegramId.get(customer._id);
    if (lastSent && lastSent >= customer.lastVisit) continue;

    await sendWinBack(shop, customer);
  }
}

async function sendWinBack(shop, customer) {
  // Live-lookup, not a snapshot — unlike a booking's userLanguage, there's
  // no single booking to read from here (this aggregates across many), and
  // a nudge sent weeks later should reflect whatever the customer's
  // preference is *now*, not whatever it was at their last visit.
  const user = await User.findOne({ telegramId: String(customer._id) }).select('language');
  const lang = normalizeLanguage(user?.language);
  const shopName = shop.name?.[lang] || shop.name?.en || shop.name?.uz || shop.name?.ru || 'us';
  const message = [
    t(lang, 'customer.winBackTitle'),
    '',
    t(lang, 'customer.winBackBody', { shopName }),
  ].join('\n');

  await notifyUser(customer._id, message, {
    reply_markup: {
      inline_keyboard: [[{ text: t(lang, 'customer.bookNowButton'), web_app: { url: `${webAppUrl}/booking/${shop._id}` } }]],
    },
  });

  await CustomerNote.findOneAndUpdate(
    { shopId: shop._id, userTelegramId: customer._id },
    { $set: { lastWinBackSentAt: new Date() } },
    { upsert: true }
  );

  console.log(`💈 Win-back sent — shop ${shop._id}, customer ${customer._id}`);
}

let intervalHandle = null;
export function startWinBackJob() {
  if (intervalHandle) return;
  runWinBackSweep();
  intervalHandle = setInterval(runWinBackSweep, CHECK_INTERVAL_MS);
}
