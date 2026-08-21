import express from 'express';
import Booking from '../models/bookingHistory.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import { confirmBooking, rejectBooking, completeBooking } from '../services/bookingActions.js';

const router = express.Router();
router.use(requireShopAdmin);

// List + filter + paginate every appointment for this shop — pending,
// upcoming confirmed, and full historical (completed/rejected/cancelled).
router.get('/', async (req, res) => {
  try {
    const { status, staffId, from, to, page = 1, limit = 20 } = req.query;
    const query = { shopId: req.shopId };

    if (status) query.status = status;
    if (staffId) query.staffId = staffId;
    if (from || to) {
      query.requestedTime = {};
      if (from) query.requestedTime.$gte = new Date(from);
      if (to) query.requestedTime.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [appointments, totalCount] = await Promise.all([
      Booking.find(query).sort({ requestedTime: -1 }).skip(skip).limit(Number(limit)),
      Booking.countDocuments(query),
    ]);

    res.status(200).json({
      appointments,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalCount / Number(limit)) || 1,
        totalCount,
      },
    });
  } catch (error) {
    console.error('Error listing admin appointments:', error);
    res.status(500).json({ message: 'Server error fetching appointments.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!booking) return res.status(404).json({ message: 'Appointment not found.' });
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error fetching admin appointment:', error);
    res.status(500).json({ message: 'Server error fetching appointment.' });
  }
});

// Confirm/reject/complete reuse the exact same logic the shop-control bot's
// buttons call, so a Telegram message and a panel click stay consistent.
router.patch('/:id/confirm', async (req, res) => {
  try {
    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await confirmBooking(req.params.id);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error confirming appointment:', error);
    res.status(500).json({ message: 'Server error confirming appointment.' });
  }
});

router.patch('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'A rejection reason is required.' });

    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await rejectBooking(req.params.id, reason);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error rejecting appointment:', error);
    res.status(500).json({ message: 'Server error rejecting appointment.' });
  }
});

router.patch('/:id/complete', async (req, res) => {
  try {
    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await completeBooking(req.params.id);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error completing appointment:', error);
    res.status(500).json({ message: 'Server error completing appointment.' });
  }
});

export default router;
