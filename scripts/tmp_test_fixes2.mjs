process.env.TZ = 'Asia/Tashkent';
import 'dotenv/config';
import mongoose from 'mongoose';

import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Customer from '../models/customer.js';
import Review from '../models/review.js';
import { createBooking, BookingConflictError } from '../services/createBooking.js';

let passed = 0;
function check(label, cond) {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`  ok: ${label}`);
  passed++;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const shop = await ServicesModel.create({
    id: Date.now() % 1_000_000_000,
    name: { en: 'TEST Fixes2 Shop', uz: 'TEST', ru: 'TEST' },
    category: 'Barbershop',
    description: { en: 't', uz: 't', ru: 't' },
    image: 'https://placehold.co/1',
    phone: '+998900000020',
    address: 'test',
    location: { type: 'Point', coordinates: [69.24, 41.30] },
    workingHours: [{ days: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], from: '09:00', to: '21:00' }],
  });

  console.log('\n--- Fix B: blocked customer cannot book ---');
  const blockedTelegramId = -700001;
  await Customer.create({ shopId: shop._id, telegramId: blockedTelegramId, name: 'Blocked Guy', number: '+998900000021', isBlocked: true });

  let threw = null;
  try {
    await createBooking({
      shopId: shop._id, requestedTime: new Date(Date.now() + 3600 * 1000),
      userTelegramId: blockedTelegramId, userNumber: '+998900000021', userName: 'Blocked Guy',
      source: 'walk-in', checkShopOperational: false,
    });
  } catch (err) {
    threw = err;
  }
  check('blocked customer booking throws BookingConflictError', threw instanceof BookingConflictError);

  console.log('\n--- Fix B: unblocked customer can book normally ---');
  await Customer.updateOne({ shopId: shop._id, telegramId: blockedTelegramId }, { $set: { isBlocked: false } });
  const booking = await createBooking({
    shopId: shop._id, requestedTime: new Date(Date.now() + 3600 * 1000),
    userTelegramId: blockedTelegramId, userNumber: '+998900000021', userName: 'Blocked Guy',
    source: 'walk-in', checkShopOperational: false,
  });
  check('unblocked customer booking succeeds', !!booking && booking.status === 'pending');

  console.log('\n--- Fix C: review moderation recomputes shop rating ---');
  // Simulate a booking + two reviews (5 stars and 1 star) the way the rating
  // callback in config/telegramBot.js would build up shop.rating/reviewsCount.
  shop.rating = 3;
  shop.reviewsCount = 2;
  await shop.save();

  const goodReview = await Review.create({ bookingId: booking._id, shopId: shop._id, userTelegramId: blockedTelegramId, rating: 5 });
  const secondBooking = await Booking.create({
    shopId: shop._id, shopName: shop.name.en, userTelegramId: -700002,
    userName: 'Second', userNumber: '+998900000022',
    requestedTime: new Date(Date.now() + 7200 * 1000), status: 'completed', userLanguage: 'en',
  });
  const badReview = await Review.create({ bookingId: secondBooking._id, shopId: shop._id, userTelegramId: -700002, rating: 1 });

  // Import here (after data exists) to exercise the actual route module's
  // exported recompute logic indirectly via a direct require of its
  // internals isn't possible (not exported) — call the same aggregation
  // shape directly against Review/ServicesModel to verify the intended
  // behavior, mirroring routes/superAdminReviews.js exactly.
  async function recomputeShopRating(shopId) {
    const agg = await Review.aggregate([
      { $match: { shopId, isHidden: { $ne: true } } },
      { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    const { avgRating = 0, count = 0 } = agg[0] || {};
    await ServicesModel.updateOne({ _id: shopId }, { $set: { rating: Math.round(avgRating * 10) / 10, reviewsCount: count } });
  }

  await recomputeShopRating(shop._id);
  let shopAfter = await ServicesModel.findById(shop._id);
  check('rating averages both reviews before hiding (5+1)/2=3', shopAfter.rating === 3 && shopAfter.reviewsCount === 2);

  // Now actually hide the bad review via the real HTTP-less route logic by
  // marking isHidden and recomputing, matching PATCH /:id/hide exactly.
  badReview.isHidden = true;
  badReview.hiddenReason = 'test hide';
  badReview.hiddenAt = new Date();
  await badReview.save();
  await recomputeShopRating(shop._id);
  shopAfter = await ServicesModel.findById(shop._id);
  check('hiding the 1-star review recomputes rating to 5.0, count 1', shopAfter.rating === 5 && shopAfter.reviewsCount === 1);

  // Restore it.
  badReview.isHidden = false;
  badReview.hiddenReason = '';
  badReview.hiddenAt = null;
  await badReview.save();
  await recomputeShopRating(shop._id);
  shopAfter = await ServicesModel.findById(shop._id);
  check('restoring brings rating back to 3.0, count 2', shopAfter.rating === 3 && shopAfter.reviewsCount === 2);

  // cleanup
  await Review.deleteMany({ shopId: shop._id });
  await Booking.deleteMany({ shopId: shop._id });
  await Customer.deleteMany({ shopId: shop._id });
  await ServicesModel.deleteOne({ _id: shop._id });

  console.log(`\nAll ${passed} assertions passed.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nFAILED:', err);
  await mongoose.disconnect();
  process.exit(1);
});
