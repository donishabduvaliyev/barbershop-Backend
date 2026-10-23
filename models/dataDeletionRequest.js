import mongoose from 'mongoose';

const dataDeletionRequestSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      default: '',
      trim: true,
      maxlength: 40,
    },
    telegramUsername: {
      type: String,
      default: '',
      trim: true,
      maxlength: 80,
    },
    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    confirmDeletion: {
      type: Boolean,
      required: true,
      default: false,
    },
    language: {
      type: String,
      default: 'uz',
      enum: ['uz', 'ru', 'en'],
    },
    status: {
      type: String,
      default: 'pending',
      enum: ['pending', 'completed', 'rejected'],
    },
  },
  { timestamps: true }
);

const DataDeletionRequest =
  mongoose.models.DataDeletionRequest ||
  mongoose.model('DataDeletionRequest', dataDeletionRequestSchema);

export default DataDeletionRequest;
