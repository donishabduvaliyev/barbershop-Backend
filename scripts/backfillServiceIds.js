// One-time migration: ServiceSchema used to be { _id: false }, so services
// saved before that change have no _id. Run once after deploying the schema
// change: `node scripts/backfillServiceIds.js`.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ServicesModel from '../models/shopData.js';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const shops = await ServicesModel.find({ 'services.0': { $exists: true } });
  let updatedShops = 0;
  let updatedServices = 0;

  for (const shop of shops) {
    let changed = false;
    for (const service of shop.services) {
      if (!service._id) {
        service._id = new mongoose.Types.ObjectId();
        changed = true;
        updatedServices += 1;
      }
    }
    if (changed) {
      await shop.save();
      updatedShops += 1;
    }
  }

  console.log(`Backfilled ${updatedServices} service id(s) across ${updatedShops} shop(s).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
