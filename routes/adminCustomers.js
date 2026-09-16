import express from 'express';
import mongoose from 'mongoose';
import Booking from '../models/bookingHistory.js';
import CustomerNote from '../models/customerNote.js';
import Customer from '../models/customer.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import { generateSyntheticTelegramId } from '../utils/syntheticCustomerId.js';

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

    // Separate from the visit aggregate above (which only counts completed
    // bookings) — a no-show is its own status and needs its own count per
    // customer, surfaced so an owner can spot a repeat no-show before
    // confirming their next request.
    const noShowAgg = await Booking.aggregate([
      { $match: { shopId: new mongoose.Types.ObjectId(req.shopId), status: 'no-show' } },
      { $group: { _id: '$userTelegramId', count: { $sum: 1 } } },
    ]);
    const noShowCountByTelegramId = new Map(noShowAgg.map((n) => [n._id, n.count]));

    const notes = await CustomerNote.find({ shopId: req.shopId }).select('userTelegramId notes');
    const notesByTelegramId = new Map(notes.map((n) => [n.userTelegramId, n.notes]));
    const customerDocs = await Customer.find({ shopId: req.shopId });
    const customerDocByTelegramId = new Map(customerDocs.map((d) => [d.telegramId, d]));

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
      noShowCount: noShowCountByTelegramId.get(c._id) || 0,
      isBlocked: !!customerDocByTelegramId.get(c._id)?.isBlocked,
    }));

    // A client added via "+ New client" (or one who's only ever had a
    // pending/rejected booking, never a completed one) has no entry in the
    // aggregate above at all — merge in every real Customer record that
    // isn't already covered, so they still show up (with zero stats)
    // instead of silently disappearing until their first completed visit.
    const coveredIds = new Set(grouped.map((c) => c._id));
    for (const doc of customerDocs) {
      if (coveredIds.has(doc.telegramId)) continue;
      if (search) {
        const haystack = `${doc.name} ${doc.number}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) continue;
      }
      customers.push({
        telegramId: doc.telegramId,
        userName: doc.name,
        userTelegramUsername: '',
        userNumber: doc.number,
        visitCount: 0,
        totalSpent: 0,
        lastVisit: null,
        favoriteServices: [],
        preferredStaff: null,
        notes: doc.notes || notesByTelegramId.get(doc.telegramId) || '',
        noShowCount: noShowCountByTelegramId.get(doc.telegramId) || 0,
        isBlocked: !!doc.isBlocked,
      });
    }

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
    const customerDoc = await Customer.findOne({ shopId: req.shopId, telegramId });
    if (bookings.length === 0 && !customerDoc) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    const completed = bookings.filter((b) => b.status === VISITED_STATUS);
    const noShows = bookings.filter((b) => b.status === 'no-show');
    const note = await CustomerNote.findOne({ shopId: req.shopId, userTelegramId: telegramId });

    res.status(200).json({
      telegramId,
      userName: customerDoc?.name || bookings[0]?.userName || '',
      userTelegramUsername: bookings[0]?.userTelegramUsername || '',
      userNumber: customerDoc?.number || bookings[0]?.userNumber || '',
      visitCount: completed.length,
      totalSpent: completed.reduce((sum, b) => sum + (b.price || 0), 0),
      lastVisit: completed[0]?.requestedTime || null,
      favoriteServices: topN(completed.map((b) => b.serviceName), 3),
      preferredStaff: topN(completed.map((b) => b.staffName), 1)[0] || null,
      notes: customerDoc?.notes || note?.notes || '',
      noShowCount: noShows.length,
      isBlocked: !!customerDoc?.isBlocked,
      timeline: bookings.map((b) => ({
        id: b._id,
        serviceName: b.serviceName,
        staffName: b.staffName,
        price: b.price,
        requestedTime: b.requestedTime,
        status: b.status,
        source: b.source,
      })),
    });
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ message: 'Server error fetching customer.' });
  }
});

// "+ New client" — a walk-in with no prior bookings gets a real Customer
// record (and a synthetic negative telegramId — see
// utils/syntheticCustomerId.js) up front, so they exist in the list and can
// be picked from the manual-booking flow before their first appointment.
router.post('/', async (req, res) => {
  try {
    const { name, number } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required.' });

    const telegramId = generateSyntheticTelegramId();
    const customer = await Customer.create({ shopId: req.shopId, telegramId, name, number: number || '' });
    res.status(201).json({
      telegramId: customer.telegramId,
      userName: customer.name,
      userTelegramUsername: '',
      userNumber: customer.number,
      visitCount: 0,
      totalSpent: 0,
      lastVisit: null,
      favoriteServices: [],
      preferredStaff: null,
      notes: '',
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({ message: 'Server error creating customer.' });
  }
});

// Edits name/number — upserts a Customer record even for a "legacy"
// customer who only exists via the booking aggregate so far (this is the
// point they get a real, editable record for the first time).
router.patch('/:telegramId', async (req, res) => {
  try {
    const telegramId = Number(req.params.telegramId);
    const { name, number } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required.' });

    const customer = await Customer.findOneAndUpdate(
      { shopId: req.shopId, telegramId },
      { $set: { name, number: number || '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(200).json({ userName: customer.name, userNumber: customer.number });
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ message: 'Server error updating customer.' });
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
