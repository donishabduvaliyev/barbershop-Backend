import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// Real, editable customer identity — everything else about a customer
// (visits, spend, favorite service, preferred staff, timeline) is still
// aggregated on read from Booking history in routes/adminCustomers.js.
// This exists specifically so a customer's name/number can be edited, and
// so a client can be added before their first booking (matches the
// "+ New client" flow in the admin panel).
//
// A customer with a real Telegram account gets this upserted automatically
// the moment they book (see routes/shops.js), keeping name/number fresh.
// A walk-in with no Telegram account is assigned a synthetic NEGATIVE
// telegramId at creation time (real Telegram ids are always positive) —
// this lets every existing piece of code that keys off userTelegramId
// (Booking documents, the customer aggregate, notification lookups) keep
// working completely unchanged for walk-ins too. Code that actually sends
// a Telegram message must guard with `if (userTelegramId > 0)` first.
const CustomerSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  telegramId: { type: Number, required: true },
  name: { type: String, required: true },
  number: { type: String, default: '' },
  notes: { type: String, default: '' },
}, { timestamps: true });

CustomerSchema.index({ shopId: 1, telegramId: 1 }, { unique: true });

const Customer = model('Customer', CustomerSchema, 'Customers');

export default Customer;
