import express from 'express';
import Review from '../models/review.js';
import ServicesModel from '../models/shopData.js';
import { requireSuperAdmin } from '../middleware/adminAuth.js';

const router = express.Router();
router.use(requireSuperAdmin);

// A shop/staff member's rating is recomputed from scratch over every
// non-hidden review, rather than reversing the incremental running-average
// update that was applied when the review was first created (config/
// telegramBot.js's rating callback) — recomputing is simple, always
// correct, and this only runs on the rare hide/restore action, not on
// every review submission.
async function recomputeShopRating(shopId) {
  const agg = await Review.aggregate([
    { $match: { shopId, isHidden: { $ne: true } } },
    { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const { avgRating = 0, count = 0 } = agg[0] || {};
  await ServicesModel.updateOne(
    { _id: shopId },
    { $set: { rating: Math.round(avgRating * 10) / 10, reviewsCount: count } }
  );
}

async function recomputeStaffRating(shopId, staffId) {
  if (!staffId) return;
  const agg = await Review.aggregate([
    { $match: { shopId, staffId, isHidden: { $ne: true }, staffRating: { $ne: null } } },
    { $group: { _id: null, avgRating: { $avg: '$staffRating' }, count: { $sum: 1 } } },
  ]);
  const { avgRating = 0, count = 0 } = agg[0] || {};
  const shop = await ServicesModel.findById(shopId).select('staff');
  const staffMember = shop?.staff?.id(staffId);
  if (!staffMember) return;
  staffMember.rating = Math.round(avgRating * 10) / 10;
  staffMember.reviewsCount = count;
  await shop.save();
}

// Every review across every shop, newest first — small enough at current
// volume that a flat list needs no pagination yet (matches routes/
// superAdmin.js's shop list, which does the same). Joins in the shop's own
// name so the list is scannable without a second lookup per row.
router.get('/', async (req, res) => {
  try {
    const { shopId, hidden } = req.query;
    const match = {};
    if (shopId) match.shopId = shopId;
    if (hidden === 'true') match.isHidden = true;
    if (hidden === 'false') match.isHidden = { $ne: true };

    const reviews = await Review.find(match)
      .sort({ createdAt: -1 })
      .populate('shopId', 'name')
      .populate({ path: 'bookingId', select: 'userName staffName' });

    res.status(200).json({
      reviews: reviews.map((r) => ({
        id: r._id,
        shopId: r.shopId?._id,
        shopName: r.shopId?.name,
        userName: r.bookingId?.userName || '',
        staffName: r.bookingId?.staffName || '',
        rating: r.rating,
        staffRating: r.staffRating,
        isHidden: r.isHidden,
        hiddenReason: r.hiddenReason,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing reviews:', error);
    res.status(500).json({ message: 'Server error fetching reviews.' });
  }
});

router.patch('/:id/hide', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found.' });

    review.isHidden = true;
    review.hiddenReason = req.body?.reason || '';
    review.hiddenAt = new Date();
    await review.save();

    await recomputeShopRating(review.shopId);
    await recomputeStaffRating(review.shopId, review.staffId);

    console.log(`🚫 Review ${review._id} hidden by super admin (Telegram user ${req.telegramId})${review.hiddenReason ? `: ${review.hiddenReason}` : ''}`);
    res.status(200).json({ id: review._id, isHidden: true });
  } catch (error) {
    console.error('Error hiding review:', error);
    res.status(500).json({ message: 'Server error hiding review.' });
  }
});

router.patch('/:id/restore', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found.' });

    review.isHidden = false;
    review.hiddenReason = '';
    review.hiddenAt = null;
    await review.save();

    await recomputeShopRating(review.shopId);
    await recomputeStaffRating(review.shopId, review.staffId);

    console.log(`♻️ Review ${review._id} restored by super admin (Telegram user ${req.telegramId})`);
    res.status(200).json({ id: review._id, isHidden: false });
  } catch (error) {
    console.error('Error restoring review:', error);
    res.status(500).json({ message: 'Server error restoring review.' });
  }
});

export default router;
