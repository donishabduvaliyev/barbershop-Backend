// One-time migration: ServiceSchema used to be { _id: false }, so services
// saved before that change have no _id. Run once after deploying the schema
// change: `node scripts/backfillServiceIds.js`.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ServicesModel from '../models/shopData.js';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  // Check against the raw collection (bypassing Mongoose hydration, which
  // auto-assigns subdocument _ids in memory as soon as a document is loaded
  // through the model — that would make `service._id` look present here even
  // though nothing was ever persisted). We only want to touch shops that
  // truly have no stored _id yet, and Mongoose's hydration-time _id still
  // needs saving once to become permanent.
  const raw = await mongoose.connection.db.collection('Shops-data')
    .find({ services: { $elemMatch: { _id: { $exists: false } } } })
    .project({ _id: 1 })
    .toArray();

  let updatedShops = 0;
  let updatedServices = 0;

  for (const { _id } of raw) {
    const shop = await ServicesModel.findById(_id);
    if (!shop) continue;
    updatedServices += shop.services.length;
    // Mongoose assigns each subdocument a fresh in-memory _id on every load
    // when one isn't stored, but doesn't treat that as a "modified" path —
    // save() alone would silently discard it again. markModified forces the
    // whole array (ids included) to be written back.
    shop.markModified('services');
    await shop.save();
    updatedShops += 1;
  }

  console.log(`Backfilled ${updatedServices} service id(s) across ${updatedShops} shop(s).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
