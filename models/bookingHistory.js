import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const BookingSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  shopName: { type: String, required: true }, 
  userTelegramId: { type: Number, required: true, index: true },
  userTelegramUsername: { type: String }, 
  userNumber: { type: String, required: true },
  userTelegramNumber: { type: String }, // Optional field for user's Telegram number
  requestedTime: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'rejected', 'completed', 'cancelled'],
    default: 'pending',
    required: true,
  },
  
  adminNotes: { type: String },
}, { timestamps: true });

const Booking = model('Booking', BookingSchema,'BookingData');

export default Booking;