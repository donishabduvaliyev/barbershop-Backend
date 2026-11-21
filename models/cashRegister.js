import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const CashRegisterSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true, index: true },
  openedBy: { type: Number, required: true },
  openedAt: { type: Date, default: Date.now },
  openingCashBalance: { type: Number, default: 0, min: 0 },
  closedBy: { type: Number, default: null },
  closedAt: { type: Date, default: null },
  closingCashBalance: { type: Number, default: null },
  expectedCashBalance: { type: Number, default: 0 },
  cashDiscrepancy: { type: Number, default: 0 },
  totalIncome: { type: Number, default: 0 },
  totalExpense: { type: Number, default: 0 },
  breakdownByMethod: {
    cash: { type: Number, default: 0 },
    click: { type: Number, default: 0 },
    payme: { type: Number, default: 0 },
    terminal_uzcard_humo: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
  },
  status: {
    type: String,
    enum: ['open', 'closed'],
    default: 'open',
    required: true,
  },
  notes: { type: String, default: '' },
}, { timestamps: true });

// Only 1 register session can be open at a time per shop
CashRegisterSchema.index(
  { shopId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'open' },
  }
);

CashRegisterSchema.index({ shopId: 1, closedAt: -1 });

const CashRegister = model('CashRegister', CashRegisterSchema, 'CashRegisters');
export default CashRegister;
