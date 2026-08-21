import express from 'express';
import mongoose from 'mongoose';
import Booking from '../models/bookingHistory.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';

const router = express.Router();
router.use(requireShopAdmin);

// Revenue and "most used" stats only count completed visits — a pending or
// rejected booking never actually earned money or occupied a chair.
const REVENUE_STATUS = 'completed';

router.get('/overview', async (req, res) => {
  try {
    const shopId = new mongoose.Types.ObjectId(req.shopId);
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().setDate(new Date().getDate() - 30));
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const dateMatch = { shopId, requestedTime: { $gte: from, $lte: to } };
    const revenueMatch = { ...dateMatch, status: REVENUE_STATUS };

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

export default router;
