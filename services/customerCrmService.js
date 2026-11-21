import mongoose from 'mongoose';
import Booking from '../models/bookingHistory.js';
import { notifyUser } from '../config/telegramBot.js';
import { escapeHtml } from '../utils/telegramFormat.js';
import ServicesModel from '../models/shopData.js';

/**
 * Computes RFM (Recency, Frequency, Monetary) customer segments for a shop.
 */
export async function computeShopCrmSegments(shopId, referenceDate = new Date()) {
  const objectShopId = new mongoose.Types.ObjectId(shopId);

  const aggregated = await Booking.aggregate([
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
  ]);

  const segments = {
    vip: { count: 0, totalLtv: 0 },
    regular: { count: 0, totalLtv: 0 },
    new: { count: 0, totalLtv: 0 },
    at_risk: { count: 0, totalLtv: 0 },
    lost: { count: 0, totalLtv: 0 },
  };

  const customers = [];
  const msPerDay = 1000 * 60 * 60 * 24;

  for (const row of aggregated) {
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
      telegramId: row._id,
      name: row.userName || 'Client',
      phone: row.userNumber || '',
      username: row.userTelegramUsername || '',
      language: row.userLanguage || 'uz',
      visitCount: row.visitCount,
      totalSpent: row.totalSpent,
      avgTicket,
      lastVisit: row.lastVisit,
      firstVisit: row.firstVisit,
      daysSinceLastVisit,
      segment,
    });
  }

  customers.sort((a, b) => b.totalSpent - a.totalSpent);

  return {
    totalClients: customers.length,
    segments,
    customers,
    atRiskClients: customers.filter((c) => c.segment === 'at_risk' && c.telegramId > 0),
  };
}

const VALID_SEGMENTS = ['vip', 'regular', 'new', 'at_risk', 'lost'];

/**
 * Broadcasts a personalized win-back / re-engagement message to selected at-risk customers.
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
    .filter((c) => c.segment === targetSegment && c.telegramId > 0)
    .slice(0, safeLimit);

  const shopName = escapeHtml(shop.name?.uz || shop.name?.en || 'Salon');
  let sentCount = 0;

  for (const client of targets) {
    const text = safeTemplate
      ? escapeHtml(safeTemplate).replace(/\{name\}/g, escapeHtml(client.name)).replace(/\{shop\}/g, shopName)
      : `✂️ <b>${shopName}</b> sizni sog'indi, ${escapeHtml(client.name)}!\n\nOxirgi tashrifingizdan beri <b>${client.daysSinceLastVisit} kun</b> o'tdi. Yangi qiyofa uchun navbat olishingiz mumkin!`;

    try {
      await notifyUser(client.telegramId, text, {
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
      sentCount += 1;
    } catch {
      // Ignore individual user blocks
    }
  }

  return {
    targetedCount: targets.length,
    sentCount,
  };
}
