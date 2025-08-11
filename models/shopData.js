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
}, { _id: false });

// Улучшенная схема для рабочих часов
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
  priceTier: {
    type: Number,
    min: 1,
    max: 4,
  },
  isPromoted: { type: Boolean, default: false },
  promotionRank: { type: Number, default: null }, 
  isEditorsChoice: { type: Boolean, default: false },
}, {
  timestamps: true, 
});


BusinessSchema.index({ location: '2dsphere' });

const ServicesModel = model('ServicesModel', BusinessSchema, 'Shops-data');

export default ServicesModel;