import express from 'express';
import mongoose from 'mongoose';
import Booking from '../models/bookingHistory.js';
import ServicesModel from '../models/shopData.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import { toDateKey, dateKeyToRange } from '../utils/dateKey.js';

const router = express.Router();
router.use(requireShopAdmin);

// Revenue and "most used" stats only count completed visits — a pending or
// rejected booking never actually earned money or occupied a chair.
const REVENUE_STATUS = 'completed';

// Shared by /today and /month: counts + revenue for bookings whose
// requestedTime falls in [from, to), plus how many of the shop's
// customers-ever are "new" within that window (their earliest booking at
// this shop, of any status, falls inside it).
async function windowStats(shopId, from, to) {
  const windowMatch = { shopId, requestedTime: { $gte: from, $lt: to } };
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
      { $match: { shopId } },
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

router.get('/overview', async (req, res) => {
  try {
    const shopId = new mongoose.Types.ObjectId(req.shopId);
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().setDate(new Date().getDate() - 30));
    const to = req.query.to ? new Date(req.query.to) : new Date();


const dateMatch = { shopId, requestedTime: { $gte: from } };
const revenueMatch = { shopId, requestedTime: { $gte: from, $lte: to }, status: REVENUE_STATUS };

    const [statusBreakdown, revenueOverTime, topServices, topStaff, totals] = await Promise.all([
      Booking.aggregate([
        { $match: dateMatch },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $project: { _id: 0, status: '$_id', count: 1 } },
      ]),

      Booking.aggregate([
        { $match: revenueMatch },
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

      Booking.aggregate([
        { $match: { ...revenueMatch, serviceId: { $ne: null } } },
        {
          $group: {
            _id: '$serviceId',
            serviceName: { $first: '$serviceName' },
            count: { $sum: 1 },
            revenue: { $sum: { $ifNull: ['$price', 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 8 },
        { $project: { _id: 0, serviceId: '$_id', serviceName: 1, count: 1, revenue: 1 } },
      ]),

      Booking.aggregate([
        { $match: { ...revenueMatch, staffId: { $ne: null } } },
        {
          $group: {
            _id: '$staffId',
            staffName: { $first: '$staffName' },
            count: { $sum: 1 },
            revenue: { $sum: { $ifNull: ['$price', 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 8 },
        { $project: { _id: 0, staffId: '$_id', staffName: 1, count: 1, revenue: 1 } },
      ]),

      Booking.aggregate([
        { $match: revenueMatch },
        { $group: { _id: null, revenue: { $sum: { $ifNull: ['$price', 0] } }, completedCount: { $sum: 1 } } },
      ]),
    ]);

    const totalAppointments = statusBreakdown.reduce((sum, s) => sum + s.count, 0);

    res.status(200).json({
      range: { from, to },
      totals: {
        appointments: totalAppointments,
        completed: totals[0]?.completedCount || 0,
        revenue: totals[0]?.revenue || 0,
      },
      statusBreakdown,
      revenueOverTime,
      topServices,
      topStaff,
    });
  } catch (error) {
    console.error('Error building admin stats overview:', error);
    res.status(500).json({ message: 'Server error building statistics.' });
  }
});

router.get('/today', async (req, res) => {
  try {
    const shopId = new mongoose.Types.ObjectId(req.shopId);
    const { start, end } = dateKeyToRange(toDateKey(new Date()));
    const stats = await windowStats(shopId, start, end);
    res.status(200).json(stats);
  } catch (error) {
    console.error('Error building today stats:', error);
    res.status(500).json({ message: 'Server error building statistics.' });
  }
});

router.get('/month', async (req, res) => {
  try {
    const shopId = new mongoose.Types.ObjectId(req.shopId);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const stats = await windowStats(shopId, start, end);
    res.status(200).json({
      ...stats,
      averageTicket: stats.completed > 0 ? Math.round(stats.revenue / stats.completed) : 0,
    });
  } catch (error) {
    console.error('Error building month stats:', error);
    res.status(500).json({ message: 'Server error building statistics.' });
  }
});

router.get('/staff', async (req, res) => {
  try {
    const shopId = new mongoose.Types.ObjectId(req.shopId);
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().setDate(new Date().getDate() - 30));
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const [perStaff, shop] = await Promise.all([
      Booking.aggregate([
        { $match: { shopId, staffId: { $ne: null }, status: REVENUE_STATUS, requestedTime: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: '$staffId',
            appointments: { $sum: 1 },
            revenue: { $sum: { $ifNull: ['$price', 0] } },
            clients: { $addToSet: '$userTelegramId' },
          },
        },
      ]),
      ServicesModel.findById(req.shopId).select('staff'),
    ]);

    const staffById = new Map((shop?.staff || []).map((s) => [String(s._id), s]));

    const rows = perStaff.map((row) => {
      const staffMember = staffById.get(String(row._id));
      const commission = staffMember?.commission ?? null;
      return {
        staffId: row._id,
        name: staffMember?.name || 'Former staff',
        rating: staffMember?.rating || 0,
        appointments: row.appointments,
        revenue: row.revenue,
        averageTicket: row.appointments > 0 ? Math.round(row.revenue / row.appointments) : 0,
        clients: row.clients.length,
        commission,
        commissionEarned: commission != null ? Math.round(row.revenue * commission / 100) : null,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    res.status(200).json({ range: { from, to }, staff: rows });
  } catch (error) {
    console.error('Error building staff performance stats:', error);
    res.status(500).json({ message: 'Server error building statistics.' });
  }
});

export default router;
