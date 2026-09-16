import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const ReviewSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  userTelegramId: { type: Number, required: true, index: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  staffId: { type: Schema.Types.ObjectId, default: null },
  staffRating: { type: Number, min: 1, max: 5, default: null },
  // Super-admin moderation — a hidden review is excluded from the shop's
  // (and staff member's) public rating/reviewsCount, recomputed from
  // scratch over every non-hidden review whenever this changes (see
  // routes/superAdminReviews.js), rather than trying to reverse the
  // incremental running-average update applied when the review was created.
  isHidden: { type: Boolean, default: false },
  hiddenReason: { type: String, default: '' },
  hiddenAt: { type: Date, default: null },
}, { timestamps: true });

const Review = model('Review', ReviewSchema, 'ReviewData');

export default Review;
