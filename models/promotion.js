import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const PromotionSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true },
  title: { type: String, required: true },
  // null = applies to all services.
  serviceId: { type: Schema.Types.ObjectId, default: null },
  discountPercent: { type: Number, required: true, min: 1, max: 100 },
  validFrom: { type: Date, required: true },
  validTo: { type: Date, required: true },
}, { timestamps: true });

const Promotion = model('Promotion', PromotionSchema, 'Promotions');

export default Promotion;
