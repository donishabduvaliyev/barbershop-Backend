import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const BookingSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  shopName: { type: String, required: true },
  userTelegramId: { type: Number, required: true, index: true },
  userTelegramUsername: { type: String },
  userNumber: { type: String, required: true },
  userTelegramNumber: { type: String }, 
  requestedTime: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'rejected', 'completed', 'cancelled'],
    default: 'pending',
    required: true,
  },
  rejectionReason: {
    type: String,
  },
  staffId: { type: Schema.Types.ObjectId, default: null },
  staffName: { type: String, default: '' },
  // Reminder/completion job bookkeeping — see jobs/reminders.js
  reminded24h: { type: Boolean, default: false },
  reminded3h: { type: Boolean, default: false },
  ratingRequested: { type: Boolean, default: false },

  adminNotes: { type: String },
}, { timestamps: true });

const Booking = model('Booking', BookingSchema, 'BookingData');

export default Booking;