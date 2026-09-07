import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// A real, DB-backed allowlist of platform operators — rather than the single
// hardcoded TELEGRAM_ADMIN_CHAT_ID env var this replaces, so more platform
// staff can be granted access later without a code change or redeploy. See
// scripts/seedSuperAdmin.js for grandfathering in the existing operator.
const SuperAdminSchema = new Schema({
  telegramId: { type: Number, unique: true, required: true },
  addedAt: { type: Date, default: Date.now },
  // Telegram id of whoever granted this access, for a minimal audit trail —
  // null for the very first (seeded) super admin, which has no granter.
  addedBy: { type: Number, default: null },
}, { timestamps: true });

const SuperAdmin = model('SuperAdmin', SuperAdminSchema, 'SuperAdmins');

export default SuperAdmin;
