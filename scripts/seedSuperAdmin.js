// One-time migration: grandfathers the existing single-operator concept
// (TELEGRAM_ADMIN_CHAT_ID env var, previously only usable via the
// shop-control bot's /gencode /unclaimed /resetowner commands) into the
// real, DB-backed SuperAdmin allowlist that now powers the web super-admin
// panel — so the current operator doesn't lose access on day one. Run:
//   node scripts/seedSuperAdmin.js [telegramId]
// With no argument, uses TELEGRAM_ADMIN_CHAT_ID from .env.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import SuperAdmin from '../models/superAdmin.js';

dotenv.config();

async function run() {
  const telegramId = Number(process.argv[2] || process.env.TELEGRAM_ADMIN_CHAT_ID);
  if (!telegramId) {
    console.error('Usage: node scripts/seedSuperAdmin.js [telegramId]  (or set TELEGRAM_ADMIN_CHAT_ID in .env)');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await SuperAdmin.findOne({ telegramId });
  if (existing) {
    console.log(`Telegram user ${telegramId} is already a super admin.`);
    await mongoose.disconnect();
    return;
  }

  await SuperAdmin.create({ telegramId, addedBy: null });
  console.log(`✅ Telegram user ${telegramId} added as a super admin.`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('seedSuperAdmin failed:', err);
  process.exit(1);
});
