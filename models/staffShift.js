import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const StaffShiftSchema = new Schema({
  shopId: { type: Schema.Types.ObjectId, ref: 'ServicesModel', required: true, index: true },
  staffId: { type: Schema.Types.ObjectId, required: true },
  date: { type: String, required: true }, // Format 'YYYY-MM-DD' in shop local timezone
  clockIn: { type: Date, default: null },
  clockOut: { type: Date, default: null },
  status: {
    type: String,
    enum: ['scheduled', 'active', 'completed', 'absent'],
    default: 'scheduled',
  },
  notes: { type: String, default: '' },
}, { timestamps: true });

StaffShiftSchema.index({ shopId: 1, staffId: 1, date: 1 }, { unique: true });
StaffShiftSchema.index({ shopId: 1, date: 1 });

const StaffShift = model('StaffShift', StaffShiftSchema, 'StaffShifts');

export default StaffShift;
