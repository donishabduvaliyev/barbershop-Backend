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
}, { timestamps: true });

const StaffSchema = new Schema({
  name: { type: String, required: true },
  title: { type: String, default: '' },
  photo: { type: String, default: '' },
  rating: { type: Number, default: 0 },
  reviewsCount: { type: Number, default: 0 },
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


const BusinessSchema = new Schema({
  id: { type: Number, required: true, unique: true },  
  name: LocalizedStringSchema,
  category: {
    type: String,
    required: true,
    enum: ["Nail Salon", "Barbershop", "Hair Salon"], 
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
}, {
  timestamps: true,
});


BusinessSchema.index({ location: '2dsphere' });
BusinessSchema.index({ ownerTelegramId: 1 });

const ServicesModel = model('ServicesModel', BusinessSchema, 'Shops-data');

export default ServicesModel;