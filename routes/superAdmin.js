import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Review from '../models/review.js';
import PageView from '../models/pageView.js';
import { requireSuperAdmin, signAdminToken } from '../middleware/adminAuth.js';
import { toDateKey, dateKeyToRange } from '../utils/dateKey.js';
import { getBotUsername, miniAppShortName } from '../config/telegramBot.js';

const router = express.Router();
router.use(requireSuperAdmin);

const REVENUE_STATUS = 'completed';

const toShopSummary = (shop) => ({
  id: shop._id,
  name: shop.name,
  category: shop.category,
  image: shop.image,
  phone: shop.phone,
  address: shop.address,
  location: shop.location,
  isOperational: shop.isOperational,
  isArchived: shop.isArchived,
  ownerTelegramId: shop.ownerTelegramId,
  hasClaimCode: !!shop.ownerClaimCode,
  rating: shop.rating,
  reviewsCount: shop.reviewsCount,
  createdAt: shop.createdAt,
});

// --- Shops: list, create, edit, claim-code, manage-as, delete/restore ---

// Every shop, with a lightweight booking count/revenue rollup so the list
// doesn't need a second round-trip per row. Partial-control surface only —
// see toShopSummary; services/staff/promotions never appear here.
router.get('/shops', async (req, res) => {
  try {
    const { search, status } = req.query;
    const match = {};
    if (search) {
      match.$or = [
        { 'name.en': { $regex: search, $options: 'i' } },
        { 'name.uz': { $regex: search, $options: 'i' } },
        { 'name.ru': { $regex: search, $options: 'i' } },
      ];
    }
    if (status === 'active') match.isOperational = true;
    if (status === 'suspended') match.isOperational = false;
    if (status === 'unclaimed') match.ownerTelegramId = null;
    // Archived shops are hidden by default (matches how they're already
    // hidden from every customer-facing listing) — only shown when
    // explicitly asked for, so "delete" doesn't just relabel "hide forever".
    match.isArchived = status === 'archived' ? true : { $ne: true };

    const shops = await ServicesModel.find(match).sort({ createdAt: -1 });
    const shopIds = shops.map((s) => s._id);

    const rollups = await Booking.aggregate([
      { $match: { shopId: { $in: shopIds }, status: REVENUE_STATUS } },
      { $group: { _id: '$shopId', bookings: { $sum: 1 }, revenue: { $sum: { $ifNull: ['$price', 0] } } } },
    ]);
    const rollupByShopId = new Map(rollups.map((r) => [String(r._id), r]));

    res.status(200).json({
      shops: shops.map((shop) => ({
        ...toShopSummary(shop),
        bookings: rollupByShopId.get(String(shop._id))?.bookings || 0,
        revenue: rollupByShopId.get(String(shop._id))?.revenue || 0,
      })),
    });
  } catch (error) {
    console.error('Error listing shops for super admin:', error);
    res.status(500).json({ message: 'Server error fetching shops.' });
  }
});

// Onboards a new shop, unclaimed by default — the same shape a shop needs
// to appear in customer listings, plus an immediate claim code so it can be
// handed to the real owner right away instead of a separate step.
router.post('/shops', async (req, res) => {
  try {
    const { name, category, description, image, phone, address, location } = req.body;
    if (!name?.en || !name?.uz || !name?.ru || !category || !phone || !address) {
      return res.status(400).json({ message: 'name (en/uz/ru), category, phone and address are required.' });
    }

    const shop = await ServicesModel.create({
      id: Date.now() % 1_000_000_000,
      name,
      category,
      // description.{en,uz,ru} is a required field on the model (customer
      // app renders it directly) — fall back to the shop name rather than
      // an empty string, which Mongoose's required validator rejects.
      description: description || { en: name.en, uz: name.uz, ru: name.ru },
      image: image || 'https://placehold.co/600x400?text=New+Shop',
      phone,
      address,
      location: location || { type: 'Point', coordinates: [69.2401, 41.2995] }, // Tashkent center, fallback
      ownerClaimCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
    });

    console.log(`🏪 Shop "${shop.name?.en}" created by super admin (Telegram user ${req.telegramId})`);
    res.status(201).json(toShopSummary(shop));
  } catch (error) {
    console.error('Error creating shop:', error);
    res.status(500).json({ message: 'Server error creating shop.' });
  }
});

// Deliberately restricted to administrative/identity fields — services,
// staff, pricing and promotions stay the shop owner's own domain, edited
// only through their own per-shop panel (see plan's "partial control").
const PARTIAL_CONTROL_FIELDS = ['name', 'category', 'address', 'phone', 'location', 'isOperational'];

router.patch('/shops/:id', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    for (const field of PARTIAL_CONTROL_FIELDS) {
      if (field in req.body) shop[field] = req.body[field];
    }
    await shop.save();
    res.status(200).json(toShopSummary(shop));
  } catch (error) {
    console.error('Error updating shop:', error);
    res.status(500).json({ message: 'Server error updating shop.' });
  }
});

// Same claim-code generation the shop-control bot's /gencode and
// /resetowner commands already use — reissuing a code always clears any
// existing owner link, forcing a fresh /claim.
router.post('/shops/:id/claim-code', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    shop.ownerClaimCode = code;
    shop.ownerTelegramId = null;
    await shop.save();

    console.log(`🔑 Claim code regenerated for "${shop.name?.en}" by super admin (Telegram user ${req.telegramId})`);
    res.status(200).json({ claimCode: code });
  } catch (error) {
    console.error('Error generating claim code:', error);
    res.status(500).json({ message: 'Server error generating claim code.' });
  }
});

// Mints a normal shop-scoped admin token so the super admin can open the
// existing, already-built shop panel for hands-on support — deliberately
// NOT a new UI; see the plan's "reuse the existing shop panel" decision.
// Audit-logged since it's real access to one owner's shop.
router.post('/shops/:id/manage-as', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.params.id).select('name');
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const token = signAdminToken({ telegramId: req.telegramId, shopId: shop._id.toString() });
    console.log(`🔐 Super admin (Telegram user ${req.telegramId}) opened "${shop.name?.en}" via Manage as this shop`);
    res.status(200).json({ token, shop: { id: shop._id, name: shop.name } });
  } catch (error) {
    console.error('Error minting manage-as token:', error);
    res.status(500).json({ message: 'Server error opening shop.' });
  }
});

// A per-shop QR code's target — a Telegram Mini App "direct link" that
// opens the app straight on this shop's page (no bot chat, no extra tap).
// Requires TELEGRAM_MINI_APP_SHORT_NAME to be set (see config/telegramBot.js
// and .env — a one-time @BotFather step); the shop id travels as the
// startapp payload, which the customer app reads from
// tg.initDataUnsafe.start_param on load (src/context/context.jsx).
router.get('/shops/:id/qr-link', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.params.id).select('_id');
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });
    if (!miniAppShortName) {
      return res.status(503).json({ message: 'Mini App short name not configured — set TELEGRAM_MINI_APP_SHORT_NAME after attaching a Mini App via @BotFather.' });
    }

    const username = await getBotUsername();
    const url = `https://t.me/${username}/${miniAppShortName}?startapp=shop_${shop._id}`;
    res.status(200).json({ url });
  } catch (error) {
    console.error('Error building shop QR link:', error);
    res.status(500).json({ message: 'Server error building QR link.' });
  }
});

router.delete('/shops/:id', async (req, res) => {
  try {
    const shop = await ServicesModel.findByIdAndUpdate(
      req.params.id,
      { $set: { isArchived: true, archivedAt: new Date() } },
      { new: true }
    );
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    console.log(`🗑️ Shop "${shop.name?.en}" archived by super admin (Telegram user ${req.telegramId})`);
    res.status(200).json(toShopSummary(shop));
  } catch (error) {
    console.error('Error archiving shop:', error);
    res.status(500).json({ message: 'Server error deleting shop.' });
  }
});

router.post('/shops/:id/restore', async (req, res) => {
  try {
    const shop = await ServicesModel.findByIdAndUpdate(
      req.params.id,
      { $set: { isArchived: false, archivedAt: null } },
      { new: true }
    );
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    console.log(`♻️ Shop "${shop.name?.en}" restored by super admin (Telegram user ${req.telegramId})`);
    res.status(200).json(toShopSummary(shop));
  } catch (error) {
    console.error('Error restoring shop:', error);
    res.status(500).json({ message: 'Server error restoring shop.' });
  }
});

// --- Platform-wide dashboard ---

// Mirrors routes/adminStats.js's windowStats exactly, just without the
// shopId filter — see that file for the reasoning behind each field.
async function platformWindowStats(from, to) {
  const windowMatch = { requestedTime: { $gte: from, $lt: to } };
  const revenueMatch = { ...windowMatch, status: REVENUE_STATUS };

  const [statusBreakdown, revenueAgg, distinctCustomers, newCustomers] = await Promise.all([
    Booking.aggregate([
      { $match: windowMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: revenueMatch },
      { $group: { _id: null, revenue: { $sum: { $ifNull: ['$price', 0] } }, completedCount: { $sum: 1 } } },
    ]),
    Booking.distinct('userTelegramId', windowMatch),
    Booking.aggregate([
      { $group: { _id: '$userTelegramId', firstVisit: { $min: '$requestedTime' } } },
      { $match: { firstVisit: { $gte: from, $lt: to } } },
      { $count: 'count' },
    ]),
  ]);

  const countByStatus = Object.fromEntries(statusBreakdown.map((s) => [s._id, s.count]));
  const appointments = statusBreakdown.reduce((sum, s) => sum + s.count, 0);

  return {
    appointments,
    completed: countByStatus.completed || 0,
    cancelled: countByStatus.cancelled || 0,
    noShows: countByStatus['no-show'] || 0,
    revenue: revenueAgg[0]?.revenue || 0,
    customers: distinctCustomers.length,
    newCustomers: newCustomers[0]?.count || 0,
  };
}

router.get('/dashboard/overview', async (req, res) => {
  try {
    const now = new Date();
    const { start: todayStart, end: todayEnd } = dateKeyToRange(toDateKey(now));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [today, month, shopCounts, revenueOverTime, avgRatingAgg, topShops] = await Promise.all([
      platformWindowStats(todayStart, todayEnd),
      platformWindowStats(monthStart, monthEnd),
      ServicesModel.aggregate([
        { $match: { isArchived: { $ne: true } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ['$isOperational', 1, 0] } },
            suspended: { $sum: { $cond: ['$isOperational', 0, 1] } },
            unclaimed: { $sum: { $cond: [{ $eq: ['$ownerTelegramId', null] }, 1, 0] } },
          },
        },
      ]),
      Booking.aggregate([
        { $match: { requestedTime: { $gte: thirtyDaysAgo }, status: REVENUE_STATUS } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$requestedTime' } },
            revenue: { $sum: { $ifNull: ['$price', 0] } },
            appointments: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, date: '$_id', revenue: 1, appointments: 1 } },
      ]),
      Review.aggregate([{ $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }]),
      Booking.aggregate([
        { $match: { requestedTime: { $gte: thirtyDaysAgo }, status: REVENUE_STATUS } },
        { $group: { _id: '$shopId', shopName: { $first: '$shopName' }, revenue: { $sum: { $ifNull: ['$price', 0] } }, bookings: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 8 },
        { $project: { _id: 0, shopId: '$_id', shopName: 1, revenue: 1, bookings: 1 } },
      ]),
    ]);

    res.status(200).json({
      today,
      month: { ...month, averageTicket: month.completed > 0 ? Math.round(month.revenue / month.completed) : 0 },
      shops: shopCounts[0] || { total: 0, active: 0, suspended: 0, unclaimed: 0 },
      revenueOverTime,
      averageRating: Math.round((avgRatingAgg[0]?.avgRating || 0) * 10) / 10,
      totalReviews: avgRatingAgg[0]?.count || 0,
      topShops,
    });
  } catch (error) {
    console.error('Error building super admin dashboard overview:', error);
    res.status(500).json({ message: 'Server error building dashboard.' });
  }
});

router.get('/dashboard/visits', async (req, res) => {
  try {
    const now = new Date();
    const { start: todayStart, end: todayEnd } = dateKeyToRange(toDateKey(now));
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [todayCount, visitsOverTime, topShops] = await Promise.all([
      PageView.countDocuments({ createdAt: { $gte: todayStart, $lt: todayEnd } }),
      PageView.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            visits: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, date: '$_id', visits: 1 } },
      ]),
      PageView.aggregate([
        { $match: { type: 'shop_view', shopId: { $ne: null }, createdAt: { $gte: sevenDaysAgo } } },
        { $group: { _id: '$shopId', views: { $sum: 1 } } },
        { $sort: { views: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'Shops-data',
            localField: '_id',
            foreignField: '_id',
            as: 'shop',
          },
        },
        { $unwind: { path: '$shop', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 0, shopId: '$_id', shopName: '$shop.name', views: 1 } },
      ]),
    ]);

    res.status(200).json({ today: todayCount, visitsOverTime, topViewedShops: topShops });
  } catch (error) {
    console.error('Error building visit stats:', error);
    res.status(500).json({ message: 'Server error building visit stats.' });
  }
});

export default router;
