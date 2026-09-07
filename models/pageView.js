import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// Deliberately minimal — a count, not a full analytics product. No
// IP/user-agent capture, no session stitching. See routes/track.js (the
// single public write endpoint) and routes/superAdmin.js's /dashboard/visits
// (the only reader).
const PageViewSchema = new Schema({
  type: { type: String, enum: ['app_open', 'shop_view'], required: true },
  shopId: { type: Schema.Types.ObjectId, default: null },
  userTelegramId: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
});

PageViewSchema.index({ createdAt: 1 });
PageViewSchema.index({ shopId: 1, createdAt: 1 });

const PageView = model('PageView', PageViewSchema, 'PageViews');

export default PageView;
