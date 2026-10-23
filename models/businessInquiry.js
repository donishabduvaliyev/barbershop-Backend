import mongoose from 'mongoose';

const businessInquirySchema = new mongoose.Schema(
  {
    businessName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    ownerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    category: {
      type: String,
      default: 'barber',
      trim: true,
      maxlength: 60,
    },
    city: {
      type: String,
      default: 'Namangan',
      trim: true,
      maxlength: 80,
    },
    staffCount: {
      type: String,
      default: '1-2',
      trim: true,
      maxlength: 30,
    },
    telegramOrInstagram: {
      type: String,
      default: '',
      trim: true,
      maxlength: 120,
    },
    message: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1000,
    },
    consentAccepted: {
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
      default: 'new',
      enum: ['new', 'contacted', 'onboarded', 'archived'],
    },
  },
  { timestamps: true }
);

const BusinessInquiry =
  mongoose.models.BusinessInquiry ||
  mongoose.model('BusinessInquiry', businessInquirySchema);

export default BusinessInquiry;
