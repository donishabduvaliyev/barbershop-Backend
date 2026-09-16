import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const LocalizedStringSchema = new Schema({
  en: { type: String, required: true },
  uz: { type: String, required: true },
  ru: { type: String, required: true },
}, { _id: false });

// One "shelf" on the client app's search page. `manual` categories are
// curated directly (an ordered shopIds list the super admin edits);
// `auto` categories carry no membership of their own — the discovery-search
// route computes them from existing shop/promotion data via `autoRule`, so
// e.g. Special Offers never needs manual upkeep as promotions start/end.
const SearchCategorySchema = new Schema({
  key: { type: String, required: true, unique: true },
  label: LocalizedStringSchema,
  icon: { type: String, default: '' },
  type: { type: String, enum: ['manual', 'auto'], required: true },
  autoRule: { type: String, enum: ['topRated', 'bestPrice', 'nearYou', 'specialOffers', null], default: null },
  // Ordered — the sequence customers see the shops in. Manual type only.
  shopIds: { type: [Schema.Types.ObjectId], default: [] },
  isActive: { type: Boolean, default: true },
  // Display order of the shelf itself on the search page.
  order: { type: Number, default: 0 },
}, { timestamps: true });

const SearchCategory = model('SearchCategory', SearchCategorySchema, 'SearchCategories');

export default SearchCategory;
