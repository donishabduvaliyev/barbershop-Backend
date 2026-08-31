import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const BookingSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  shopName: { type: String, required: true },
  userTelegramId: { type: Number, required: true, index: true },
  userTelegramUsername: { type: String },
  userName: { type: String, default: '' },
  userNumber: { type: String, required: true },
  userTelegramNumber: { type: String }, 
  requestedTime: { type: Date, required: true },
  status: {
    type: String,
    // 'no-show' is applied manually (see services/bookingActions.js's
    // markNoShow) — the reminder sweep optimistically auto-completes any
    // confirmed booking once its time passes, since it has no way to know
    // whether the customer actually came; the owner corrects it afterward
    // if they didn't. Excluded from revenue/visit counts everywhere those
    // only match status: 'completed'.
    enum: ['pending', 'confirmed', 'rejected', 'completed', 'cancelled', 'no-show'],
    default: 'pending',
    required: true,
  },
  rejectionReason: {
    type: String,
  },
  staffId: { type: Schema.Types.ObjectId, default: null },
  staffName: { type: String, default: '' },
  // Only set for "any available" bookings (staffId: null) — an atomically
  // claimed number in [0, shop.capacity) that makes those bookings
  // race-proof the same way the staffId index does for specific-staff ones.
  // See routes/shops.js's claimVirtualSlot.
  virtualSlot: { type: Number, default: null },
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
  // Set while the shop-control bot is waiting on the owner's free-text
  // rejection reason (after they tap "Reject"). Persisted here rather than
  // kept in an in-memory Map so a server restart mid-flow doesn't strand
  // the booking on "Awaiting rejection reason…" forever.
  awaitingRejectionReason: { type: Boolean, default: false },
  // Reminder/completion job bookkeeping — see jobs/reminders.js
  reminded24h: { type: Boolean, default: false },
  reminded3h: { type: Boolean, default: false },
  ratingRequested: { type: Boolean, default: false },

  adminNotes: { type: String },
}, { timestamps: true });

// Hard, race-proof guarantee that a specific staff member can never hold two
// active bookings for the same exact hour — enforced at the database level,
// not just checked-then-inserted in application code, so two simultaneous
// requests for the same barber/slot can't both slip through.
BookingSchema.index(
  { shopId: 1, staffId: 1, requestedTime: 1 },
  {
    unique: true,
    partialFilterExpression: {
      staffId: { $type: 'objectId' },
      status: { $in: ['pending', 'confirmed'] },
    },
  }
);

// Same guarantee for "any available" bookings — each one atomically claims
// a virtualSlot number, and this index makes double-claiming the same
// number for the same shop/hour impossible, however many requests race.
BookingSchema.index(
  { shopId: 1, requestedTime: 1, virtualSlot: 1 },
  {
    unique: true,
    partialFilterExpression: {
      virtualSlot: { $type: 'number' },
      status: { $in: ['pending', 'confirmed'] },
    },
  }
);

const Booking = model('Booking', BookingSchema, 'BookingData');

export default Booking;