import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const ReviewSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  userTelegramId: { type: Number, required: true, index: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  staffId: { type: Schema.Types.ObjectId, default: null },
  staffRating: { type: Number, min: 1, max: 5, default: null },
}, { timestamps: true });

const Review = model('Review', ReviewSchema, 'ReviewData');

export default Review;
