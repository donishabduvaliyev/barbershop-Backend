import mongoose, { model } from 'mongoose';
const { Schema } = mongoose;

const LocalizedStringSchema = new Schema({
  en: { type: String, required: true },
  uz: { type: String, required: true },
  ru: { type: String, required: true },
}, { _id: false });


const ServiceSchema = new Schema({
  name: LocalizedStringSchema,
  price: { type: Number, required: true },
  durationMinutes: { type: Number, required: true },
  // Temporarily hides this service from the customer app and every booking
  // picker (bookable-service validation in routes/shops.js) without
  // deleting it — deleting already has its own upcoming-bookings safety
  // check (routes/adminShop.js) and is meant to be permanent; this is for
  // a short pause ("out of product for this").
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const WorkingHoursSchema = new Schema({
  days: [{
    type: String,
    enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    required: true,
  }],
  from: { type: String, required: true },
  to: { type: String, required: true },
}, { _id: false });

const StaffSchema = new Schema({
  name: { type: String, required: true },
  title: { type: String, default: '' },
  photo: { type: String, default: '' },
  rating: { type: Number, default: 0 },
  reviewsCount: { type: Number, default: 0 },
  // Specific calendar dates ('YYYY-MM-DD', shop-local) this staff member is
  // off — not a recurring weekly pattern, since a day off is normally
  // scheduled ad hoc. Enforced server-side in routes/shops.js's booking
  // validation, not just hidden in the UI — see utils/dateKey.js.
  daysOff: { type: [String], default: [] },
  // Which shop services this person actually performs — empty means
  // "performs everything" (the backward-compatible default for staff no
  // one has restricted yet), so booking a service filters staff by this.
  serviceIds: { type: [Schema.Types.ObjectId], default: [] },
  // Overrides the shop's blanket workingHours when set; empty means "same
  // hours as the shop". Same shape so one editor UI serves both.
  workingHours: { type: [WorkingHoursSchema], default: [] },
  // Owner's own bookkeeping reference — not consumed by any booking logic.
  commission: { type: Number, min: 0, max: 100, default: null },
  // Manual "called in sick / stepped out" override — separate from daysOff
  // (a pre-scheduled whole day) and workingHours (the recurring weekly
  // schedule), and deliberately NOT date-stamped: it's a live "is he here
  // right now" status, so booking logic only ever consults it for TODAY's
  // slots (both "any available" and a specific-staff pick) — a future-dated
  // booking for this same staff member is unaffected, so the owner
  // forgetting to flip it back on can't silently block next week too.
  isAvailableNow: { type: Boolean, default: true },
}, { timestamps: true });


const BusinessSchema = new Schema({
  id: { type: Number, required: true, unique: true },  
  name: LocalizedStringSchema,
  category: {
    type: String,
    required: true,
    // Kept in sync with SHOP_CATEGORIES in barbershop-main's SearchPege.jsx —
    // that's the customer-facing list of filterable categories, and a value
    // it advertises that isn't allowed here would show up as a permanently
    // empty search filter (no shop could ever be assigned to it).
    enum: ["Nail Salon", "Barbershop", "Hair Salon", "Massage Therapy", "Beauty Spas"], 
  },
  description: LocalizedStringSchema,
  image: { type: String, required: true }, 
  images: [String],
  rating: { type: Number, default: 0 },
  isOperational: { type: Boolean, default: true },
  reviewsCount: { type: Number, default: 0 },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: true
    },
    coordinates: {
      type: [Number], 
      required: true
    }
  },
  services: [ServiceSchema],
  workingHours: [WorkingHoursSchema],
  // Empty by default — the "Meet the Team" section only renders once a shop
  // actually has staff entries, and booking only offers a staff picker then too.
  staff: { type: [StaffSchema], default: [] },
  // How many clients this shop can serve at the same hour — only consulted
  // when the shop hasn't named individual staff (some shops track named
  // barbers, others just track "we have N chairs"). Defaults to 1 so a
  // staffless shop with no capacity set behaves exactly as before.
  capacity: { type: Number, default: 1, min: 1 },
  priceTier: {
    type: Number,
    min: 1,
    max: 4,
  },
  isPromoted: { type: Boolean, default: false },
  promotionRank: { type: Number, default: null },
  isEditorsChoice: { type: Boolean, default: false },
  // Links this shop to its owner's Telegram account, set once via the
  // shop-control bot's /claim flow (see config/shopControlBot.js). One
  // Telegram account may own several shops (no uniqueness constraint here) —
  // routes/adminAuth.js handles picking which one to manage on login.
  ownerTelegramId: { type: Number, default: null },
  ownerClaimCode: { type: String, default: null },
  // Automatic "it's been a while" nudges to lapsed customers — see
  // jobs/winBack.js. On by default; owners can turn it off in Settings.
  winBackEnabled: { type: Boolean, default: true },
  // Soft-delete, set only via the super admin's DELETE /superadmin/shops/:id
  // (routes/superAdmin.js). A shop's Booking/Review history references
  // shopId, so this is never a hard delete — an archived shop just drops out
  // of every customer-facing listing (see routes/shops.js) while its stats
  // and history stay intact and it remains visible/restorable in the
  // super-admin panel.
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null },
}, {
  timestamps: true,
});


BusinessSchema.index({ location: '2dsphere' });
BusinessSchema.index({ ownerTelegramId: 1 });

// Every customer-facing browse/search query (routes/shops.js's home-feed,
// discovery-search, search-shops) filters on isOperational/isArchived and
// sorts by rating or promotionRank — without an index covering that shape,
// each of those queries is a full collection scan plus an in-memory sort on
// every single request, which is exactly the kind of per-query cost that
// gets expensive fastest under concurrent load.
BusinessSchema.index({ isOperational: 1, isArchived: 1, rating: -1 });
BusinessSchema.index({ isOperational: 1, isArchived: 1, isPromoted: 1, promotionRank: 1 });
BusinessSchema.index({ category: 1 });

const ServicesModel = model('ServicesModel', BusinessSchema, 'Shops-data');

export default ServicesModel;