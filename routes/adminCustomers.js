import express from 'express';
import mongoose from 'mongoose';
import Booking from '../models/bookingHistory.js';
import CustomerNote from '../models/customerNote.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';

const router = express.Router();
router.use(requireShopAdmin);

// "Visited" means completed — matches the same convention routes/adminStats.js
// already uses for revenue: a pending or rejected booking never actually happened.
const VISITED_STATUS = 'completed';

// Most-frequent-first, for "favorite service(s)" / "preferred staff" — done
// in Node rather than a $topN aggregation stage since a single shop's
// customer list is small enough that this is simpler to read and reason
// about than the equivalent pipeline.
function topN(items, n) {
  const counts = new Map();
  for (const item of items) {
    if (!item) continue;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name]) => name);
}

router.get('/', async (req, res) => {
  try {
    const search = req.query.search?.trim();
    const match = { shopId: new mongoose.Types.ObjectId(req.shopId), status: VISITED_STATUS };
    if (search) {
      match.$or = [
        { userName: { $regex: search, $options: 'i' } },
        { userNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const grouped = await Booking.aggregate([
      { $match: match },
      { $sort: { requestedTime: -1 } },
      {
        $group: {
          _id: '$userTelegramId',
          userName: { $first: '$userName' },
          userTelegramUsername: { $first: '$userTelegramUsername' },
          userNumber: { $first: '$userNumber' },
          visitCount: { $sum: 1 },
          totalSpent: { $sum: { $ifNull: ['$price', 0] } },
          lastVisit: { $first: '$requestedTime' },
          serviceNames: { $push: '$serviceName' },
          staffNames: { $push: '$staffName' },
        },
      },
      { $sort: { lastVisit: -1 } },
    ]);

    const notes = await CustomerNote.find({ shopId: req.shopId }).select('userTelegramId notes');
    const notesByTelegramId = new Map(notes.map((n) => [n.userTelegramId, n.notes]));

    const customers = grouped.map((c) => ({
      telegramId: c._id,
      userName: c.userName,
      userTelegramUsername: c.userTelegramUsername,
      userNumber: c.userNumber,
      visitCount: c.visitCount,
      totalSpent: c.totalSpent,
      lastVisit: c.lastVisit,
      favoriteServices: topN(c.serviceNames, 3),
      preferredStaff: topN(c.staffNames, 1)[0] || null,
      notes: notesByTelegramId.get(c._id) || '',
    }));

    res.status(200).json({ customers });
  } catch (error) {
    console.error('Error listing customers:', error);
    res.status(500).json({ message: 'Server error fetching customers.' });
  }
});

router.get('/:telegramId', async (req, res) => {
  try {
    const telegramId = Number(req.params.telegramId);
    const bookings = await Booking.find({ shopId: req.shopId, userTelegramId: telegramId }).sort({ requestedTime: -1 });
    if (bookings.length === 0) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    const completed = bookings.filter((b) => b.status === VISITED_STATUS);
    const note = await CustomerNote.findOne({ shopId: req.shopId, userTelegramId: telegramId });

    res.status(200).json({
      telegramId,
      userName: bookings[0].userName,
      userTelegramUsername: bookings[0].userTelegramUsername,
      userNumber: bookings[0].userNumber,
      visitCount: completed.length,
      totalSpent: completed.reduce((sum, b) => sum + (b.price || 0), 0),
      lastVisit: completed[0]?.requestedTime || null,
      favoriteServices: topN(completed.map((b) => b.serviceName), 3),
      preferredStaff: topN(completed.map((b) => b.staffName), 1)[0] || null,
      notes: note?.notes || '',
      timeline: bookings.map((b) => ({
        id: b._id,
        serviceName: b.serviceName,
        staffName: b.staffName,
        price: b.price,
        requestedTime: b.requestedTime,
        status: b.status,
      })),
    });
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ message: 'Server error fetching customer.' });
  }
});

router.patch('/:telegramId/notes', async (req, res) => {
  try {
    const telegramId = Number(req.params.telegramId);
    const { notes } = req.body;
    const updated = await CustomerNote.findOneAndUpdate(
      { shopId: req.shopId, userTelegramId: telegramId },
      { $set: { notes: notes || '' } },
      { upsert: true, new: true }
    );
    res.status(200).json({ notes: updated.notes });
  } catch (error) {
    console.error('Error saving customer notes:', error);
    res.status(500).json({ message: 'Server error saving notes.' });
  }
});

export default router;
