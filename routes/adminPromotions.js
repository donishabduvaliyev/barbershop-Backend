import express from 'express';
import mongoose from 'mongoose';
import Promotion from '../models/promotion.js';
import Booking from '../models/bookingHistory.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import { notifyUser } from '../config/telegramBot.js';
import { DIVIDER } from '../utils/telegramFormat.js';

const router = express.Router();
router.use(requireShopAdmin);

const INACTIVE_DAYS = 60;

// Matches the CRM's convention (routes/adminCustomers.js): a customer is
// anyone with at least one completed visit at this shop.
async function segmentCustomers(shopId, segment) {
  const grouped = await Booking.aggregate([
    { $match: { shopId: new mongoose.Types.ObjectId(shopId), status: 'completed' } },
    { $sort: { requestedTime: -1 } },
    { $group: { _id: '$userTelegramId', lastVisit: { $first: '$requestedTime' } } },
  ]);

  if (segment === 'inactive60') {
    const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);
    return grouped.filter((c) => c.lastVisit <= cutoff);
  }
  return grouped;
}

router.get('/', async (req, res) => {
  try {
    const promotions = await Promotion.find({ shopId: req.shopId }).sort({ createdAt: -1 });
    res.status(200).json({ promotions });
  } catch (error) {
    console.error('Error listing promotions:', error);
    res.status(500).json({ message: 'Server error fetching promotions.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, serviceId, discountPercent, validFrom, validTo } = req.body;
    if (!title || !discountPercent || !validFrom || !validTo) {
      return res.status(400).json({ message: 'title, discountPercent, validFrom and validTo are required.' });
    }

    const promotion = await Promotion.create({
      shopId: req.shopId,
      title,
      serviceId: serviceId || null,
      discountPercent,
      validFrom: new Date(validFrom),
      validTo: new Date(validTo),
    });
    res.status(201).json(promotion);
  } catch (error) {
    console.error('Error creating promotion:', error);
    res.status(500).json({ message: 'Server error creating promotion.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Promotion.findOneAndDelete({ _id: req.params.id, shopId: req.shopId });
    if (!deleted) return res.status(404).json({ message: 'Promotion not found.' });
    res.status(200).json({ message: 'Promotion deleted.' });
  } catch (error) {
    console.error('Error deleting promotion:', error);
    res.status(500).json({ message: 'Server error deleting promotion.' });
  }
});

// Two-step by design: without ?confirm=true this only reports how many
// customers would be messaged. Sending a promo reaches real people and
// can't be undone, so the panel must show the count and get an explicit
// confirmation before this route is called again with ?confirm=true.
router.post('/:id/send', async (req, res) => {
  try {
    const { segment } = req.body;
    if (!['all', 'inactive60'].includes(segment)) {
      return res.status(400).json({ message: "segment must be 'all' or 'inactive60'." });
    }

    const promotion = await Promotion.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!promotion) return res.status(404).json({ message: 'Promotion not found.' });

    const targets = await segmentCustomers(req.shopId, segment);

    if (req.query.confirm !== 'true') {
      return res.status(200).json({ recipientCount: targets.length });
    }

    const message = [
      `🎉 *${promotion.title}*`,
      DIVIDER,
      `Enjoy *${promotion.discountPercent}% off* through ${promotion.validTo.toLocaleDateString('en-US', { timeZone: 'UTC' })}.`,
    ].join('\n');

    for (const target of targets) {
      await notifyUser(target._id, message);
      // Telegram's per-chat rate limit is generous, but a small stagger
      // keeps a large send from bursting the bot's overall message rate.
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    res.status(200).json({ recipientCount: targets.length, sent: true });
  } catch (error) {
    console.error('Error sending promotion:', error);
    res.status(500).json({ message: 'Server error sending promotion.' });
  }
});

export default router;
