import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const TransactionSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true, index: true },
  registerId: { type: Schema.Types.ObjectId, ref: 'CashRegister', required: true, index: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
  type: {
    type: String,
    enum: ['service_payment', 'product_sale', 'expense', 'payout', 'tip'],
    required: true,
  },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: {
    type: String,
    enum: ['cash', 'click', 'payme', 'terminal_uzcard_humo', 'other'],
    default: 'cash',
    required: true,
  },
  staffId: { type: Schema.Types.ObjectId, default: null },
  staffName: { type: String, default: '' },
  description: { type: String, default: '' },
  customerName: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  recordedBy: { type: Number, default: null },
}, { timestamps: true });

TransactionSchema.index({ shopId: 1, createdAt: -1 });
TransactionSchema.index({ registerId: 1, type: 1 });

const Transaction = model('Transaction', TransactionSchema, 'Transactions');
export default Transaction;
