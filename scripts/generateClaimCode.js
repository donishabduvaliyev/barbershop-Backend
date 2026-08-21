// Platform-operator tool: generates a one-time claim code for a shop so its
// owner can link their Telegram account via the shop-control bot's
// `/claim CODE` command (see config/shopControlBot.js). Run:
//   node scripts/generateClaimCode.js "<shop _id or name substring>"
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import crypto from 'crypto';
import ServicesModel from '../models/shopData.js';

dotenv.config();

async function run() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node scripts/generateClaimCode.js "<shop _id or name substring>"');
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

  if (shop.ownerTelegramId) {
    console.log(`"${shop.name.en}" is already claimed by Telegram user ${shop.ownerTelegramId}.`);
    await mongoose.disconnect();
    return;
  }

  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  shop.ownerClaimCode = code;
  await shop.save();

  console.log(`Claim code for "${shop.name.en}": ${code}`);
  console.log('Have the shop owner DM the shop-control bot with:');
  console.log(`  /claim ${code}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('generateClaimCode failed:', err);
  process.exit(1);
});
