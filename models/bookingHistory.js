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
  // Snapshotted at booking time (not a live reference) so editing/deleting a
  // service later never rewrites historical revenue or "most used" stats.
  serviceId: { type: Schema.Types.ObjectId, default: null },
  serviceName: { type: String, default: '' },
  price: { type: Number, default: null },
  // Identifies the shop-control bot message this booking was first posted
  // as, so any actor (the bot's own buttons, or the admin panel) can edit
  // that same message in place when the status changes.
  notificationChatId: { type: Number, default: null },
  notificationMessageId: { type: Number, default: null },
  // Reminder/completion job bookkeeping — see jobs/reminders.js
  reminded24h: { type: Boolean, default: false },
  reminded3h: { type: Boolean, default: false },
  ratingRequested: { type: Boolean, default: false },

  adminNotes: { type: String },
}, { timestamps: true });

const Booking = model('Booking', BookingSchema, 'BookingData');

export default Booking;