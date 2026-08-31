import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// The only piece of a customer's CRM profile that can't be computed from
// Booking history — everything else (visits, spend, favorite service,
// preferred staff, timeline) is aggregated on read in routes/adminCustomers.js.
const CustomerNoteSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  userTelegramId: { type: Number, required: true },
  notes: { type: String, default: '' },
  // When this customer was last sent an "it's been a while" win-back
  // message (jobs/winBack.js) — compared against their latest completed
  // visit so the same inactive streak never gets nudged twice.
  lastWinBackSentAt: { type: Date, default: null },
}, { timestamps: true });

CustomerNoteSchema.index({ shopId: 1, userTelegramId: 1 }, { unique: true });

const CustomerNote = model('CustomerNote', CustomerNoteSchema, 'CustomerNotes');

export default CustomerNote;
