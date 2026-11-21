import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const WaitlistEntrySchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true, index: true },
  queueNumber: { type: Number, required: true },
  date: { type: String, required: true }, // 'YYYY-MM-DD' in shop local timezone
  customerName: { type: String, required: true },
  customerPhone: { type: String, required: true },
  telegramId: { type: Number, default: null },
  staffId: { type: Schema.Types.ObjectId, default: null }, // null = any available master
  staffName: { type: String, default: '' },
  serviceId: { type: Schema.Types.ObjectId, default: null },
  serviceName: { type: String, default: '' },
  price: { type: Number, default: null },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
  estimatedWaitMinutes: { type: Number, default: 15 },
  status: {
    type: String,
    enum: ['waiting', 'called', 'in_chair', 'completed', 'cancelled', 'no_show'],
    default: 'waiting',
    required: true,
  },
  joinedAt: { type: Date, default: Date.now },
  calledAt: { type: Date, default: null },
  seatedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  notes: { type: String, default: '' },
}, { timestamps: true });

WaitlistEntrySchema.index({ shopId: 1, date: 1, queueNumber: 1 }, { unique: true });
WaitlistEntrySchema.index({ shopId: 1, date: 1, status: 1 });
WaitlistEntrySchema.index({ telegramId: 1, date: 1 });

const WaitlistEntry = model('WaitlistEntry', WaitlistEntrySchema, 'WaitlistEntries');
export default WaitlistEntry;
