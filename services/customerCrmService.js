import mongoose from 'mongoose';
import Booking from '../models/bookingHistory.js';
import Customer from '../models/customer.js';
import { notifyUser } from '../config/telegramBot.js';
import { escapeHtml } from '../utils/telegramFormat.js';
import ServicesModel from '../models/shopData.js';

/**
 * Computes RFM (Recency, Frequency, Monetary) customer segments for a shop.
 * Merges Customer records (edits, blocks, 0-visit manual clients) with Booking history.
 */
export async function computeShopCrmSegments(shopId, referenceDate = new Date()) {
  const objectShopId = new mongoose.Types.ObjectId(shopId);

  const [aggregated, customerDocs] = await Promise.all([
    Booking.aggregate([
      { $match: { shopId: objectShopId, status: 'completed' } },
      { $sort: { requestedTime: -1 } },
      {
        $group: {
          _id: '$userTelegramId',
          userName: { $first: '$userName' },
          userNumber: { $first: '$userNumber' },
          userTelegramUsername: { $first: '$userTelegramUsername' },
          userLanguage: { $first: '$userLanguage' },
          visitCount: { $sum: 1 },
          totalSpent: { $sum: { $ifNull: ['$price', 0] } },
          lastVisit: { $first: '$requestedTime' },
          firstVisit: { $last: '$requestedTime' },
        },
      },
    ]),
    Customer.find({ shopId: objectShopId }).lean(),
  ]);

  const customerMap = new Map(customerDocs.map((c) => [Number(c.telegramId), c]));

  const segments = {
    vip: { count: 0, totalLtv: 0 },
    regular: { count: 0, totalLtv: 0 },
    new: { count: 0, totalLtv: 0 },
    at_risk: { count: 0, totalLtv: 0 },
    lost: { count: 0, totalLtv: 0 },
  };

  const customers = [];
  const seenIds = new Set();
  const msPerDay = 1000 * 60 * 60 * 24;

  for (const row of aggregated) {
    const tid = Number(row._id);
    seenIds.add(tid);
    const doc = customerMap.get(tid);

    const daysSinceLastVisit = Math.max(
      0,
      Math.floor((referenceDate.getTime() - new Date(row.lastVisit).getTime()) / msPerDay)
    );
    const avgTicket = row.visitCount > 0 ? Math.round(row.totalSpent / row.visitCount) : 0;

    let segment = 'new';
    if (daysSinceLastVisit > 60) {
      segment = 'lost';
    } else if (daysSinceLastVisit > 28) {
      segment = 'at_risk';
    } else if (row.visitCount >= 8 || row.totalSpent >= 1000000) {
      segment = 'vip';
    } else if (row.visitCount >= 3) {
      segment = 'regular';
    } else {
      segment = 'new';
    }

    segments[segment].count += 1;
    segments[segment].totalLtv += row.totalSpent;

    customers.push({
      telegramId: tid,
      name: doc?.name || row.userName || 'Client',
      phone: doc?.number || row.userNumber || '',
      username: row.userTelegramUsername || '',
      language: row.userLanguage || 'uz',
      visitCount: row.visitCount,
      totalSpent: row.totalSpent,
      avgTicket,
      lastVisit: row.lastVisit,
      firstVisit: row.firstVisit,
      daysSinceLastVisit,
      isBlocked: !!doc?.isBlocked,
      segment,
    });
  }

  // Include manually added 0-visit clients in 'new' segment so counts match /admin/customers
  for (const doc of customerDocs) {
    const tid = Number(doc.telegramId);
    if (seenIds.has(tid)) continue;

    segments.new.count += 1;
    customers.push({
      telegramId: tid,
      name: doc.name || 'Client',
      phone: doc.number || '',
      username: '',
      language: 'uz',
      visitCount: 0,
      totalSpent: 0,
      avgTicket: 0,
      lastVisit: null,
      firstVisit: null,
      daysSinceLastVisit: 0,
      isBlocked: !!doc.isBlocked,
      segment: 'new',
    });
  }

  customers.sort((a, b) => b.totalSpent - a.totalSpent);

  return {
    totalClients: customers.length,
    segments,
    customers,
    atRiskClients: customers.filter((c) => c.segment === 'at_risk' && c.telegramId > 0 && !c.isBlocked),
  };
}

const VALID_SEGMENTS = ['vip', 'regular', 'new', 'at_risk', 'lost'];

/**
 * Broadcasts a personalized win-back / re-engagement message to selected unblocked customers.
 */
export async function sendReengagementBroadcast(shopId, { messageTemplate, targetSegment = 'at_risk', limit = 50 }) {
  if (!VALID_SEGMENTS.includes(targetSegment)) {
    const err = new Error(`Invalid targetSegment. Must be one of: ${VALID_SEGMENTS.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  if (messageTemplate !== undefined && messageTemplate !== null && typeof messageTemplate !== 'string') {
    const err = new Error('messageTemplate must be a string');
    err.statusCode = 400;
    throw err;
  }

  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  const safeTemplate = typeof messageTemplate === 'string' ? messageTemplate.trim().slice(0, 1000) : '';

  const shop = await ServicesModel.findById(shopId).select('name');
  if (!shop) {
    const err = new Error('Shop not found');
    err.statusCode = 404;
    throw err;
  }

  const crm = await computeShopCrmSegments(shopId);
  const targets = crm.customers
    .filter((c) => c.segment === targetSegment && c.telegramId > 0 && !c.isBlocked)
    .slice(0, safeLimit);

  const shopName = escapeHtml(shop.name?.uz || shop.name?.en || 'Salon');
  let sentCount = 0;

  for (const client of targets) {
    const safeClientName = escapeHtml(client.name);
    const text = safeTemplate
      ? escapeHtml(safeTemplate)
          .replace(/\{name\}/g, () => safeClientName)
          .replace(/\{shop\}/g, () => shopName)
      : `✂️ <b>${shopName}</b> sizni sog'indi, ${safeClientName}!\n\nOxirgi tashrifingizdan beri <b>${client.daysSinceLastVisit} kun</b> o'tdi. Yangi qiyofa uchun navbat olishingiz mumkin!`;

    try {
      const ok = await notifyUser(client.telegramId, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            {
              text: '⚡️ Band qilish / Записаться',
              callback_data: `book_shop_${shopId}`,
              style: 'success',
            },
          ]],
        },
      });
      if (ok !== false) {
        sentCount += 1;
      }
    } catch {
      // Ignore individual user blocks
    }
  }

  return {
    targetedCount: targets.length,
    sentCount,
  };
}
