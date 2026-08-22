// Platform-operator override: forcibly clears a shop's current owner and
// issues a fresh claim code in one step — for when a shop changes hands, or
// the current owner lost access to their Telegram account and can't run
// /unclaim themselves. Run:
//   node scripts/resetOwnership.js "<shop _id or name substring>"
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import crypto from 'crypto';
import ServicesModel from '../models/shopData.js';

dotenv.config();

async function run() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node scripts/resetOwnership.js "<shop _id or name substring>"');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const shop = mongoose.isValidObjectId(query)
    ? await ServicesModel.findById(query)
    : await ServicesModel.findOne({ 'name.en': { $regex: query, $options: 'i' } });

  if (!shop) {
    console.error(`No shop found matching "${query}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const previousOwner = shop.ownerTelegramId;
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();

  shop.ownerTelegramId = null;
  shop.ownerClaimCode = code;
  await shop.save();

  console.log(`"${shop.name.en}" ownership reset${previousOwner ? ` (was Telegram user ${previousOwner})` : ''}.`);
  console.log(`New claim code: ${code}`);
  console.log('Have the new owner DM the shop-control bot with:');
  console.log(`  /claim ${code}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('resetOwnership failed:', err);
  process.exit(1);
});
