// One-time setup for the search-categories feature — creates the default
// shelves (idempotent: skips any key that already exists) and migrates the
// legacy isEditorsChoice boolean into the new manual category so existing
// editor's-choice shops don't disappear from the search page.
//
// Run once: node scripts/seedSearchCategories.js
process.env.TZ = 'Asia/Tashkent';

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import SearchCategory from '../models/searchCategory.js';
import ServicesModel from '../models/shopData.js';

const DEFAULT_CATEGORIES = [
  {
    key: 'editors-choice',
    label: { en: "Editor's Choice", uz: 'Tahririyat tanlovi', ru: 'Выбор редакции' },
    type: 'manual',
    order: 0,
  },
  {
    key: 'top-rated',
    label: { en: 'Top Rated', uz: 'Eng yuqori baholangan', ru: 'Самые популярные' },
    type: 'auto',
    autoRule: 'topRated',
    order: 1,
  },
  {
    key: 'special-offers',
    label: { en: 'Special Offers', uz: 'Maxsus takliflar', ru: 'Специальные предложения' },
    type: 'auto',
    autoRule: 'specialOffers',
    order: 2,
  },
  {
    key: 'best-price',
    label: { en: 'Best Prices', uz: 'Eng yaxshi narxlar', ru: 'Лучшие цены' },
    type: 'auto',
    autoRule: 'bestPrice',
    order: 3,
  },
  {
    key: 'near-you',
    label: { en: 'Near You', uz: 'Sizga yaqin', ru: 'Рядом с вами' },
    type: 'auto',
    autoRule: 'nearYou',
    order: 4,
  },
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  for (const def of DEFAULT_CATEGORIES) {
    const existing = await SearchCategory.findOne({ key: def.key });
    if (existing) {
      console.log(`skip (exists): ${def.key}`);
      continue;
    }

    const doc = { ...def };
    if (def.key === 'editors-choice') {
      const legacyShops = await ServicesModel.find({ isEditorsChoice: true }).select('_id');
      doc.shopIds = legacyShops.map((s) => s._id);
      console.log(`migrating ${doc.shopIds.length} shop(s) with isEditorsChoice=true`);
    }

    await SearchCategory.create(doc);
    console.log(`created: ${def.key}`);
  }

  await mongoose.disconnect();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
