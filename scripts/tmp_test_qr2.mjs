import 'dotenv/config';
import mongoose from 'mongoose';
import ServicesModel from '../models/shopData.js';
import SuperAdmin from '../models/superAdmin.js';
import { signSuperAdminToken } from '../middleware/adminAuth.js';

const BASE = 'http://localhost:5999/api';
let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); failures++; }
  else console.log('✅', msg);
}

await mongoose.connect(process.env.MONGO_URI);

const FAKE_SUPERADMIN_ID = 800000000002;
await SuperAdmin.deleteOne({ telegramId: FAKE_SUPERADMIN_ID });
await SuperAdmin.create({ telegramId: FAKE_SUPERADMIN_ID });
const token = signSuperAdminToken({ telegramId: FAKE_SUPERADMIN_ID });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

await ServicesModel.deleteMany({ 'name.en': 'QR Test Shop 2' });
const shop = await ServicesModel.create({
  id: Date.now() % 1_000_000_000,
  name: { en: 'QR Test Shop 2', uz: 'QR Test 2', ru: 'QR Тест 2' },
  category: 'Barbershop',
  description: { en: 'Test', uz: 'Test', ru: 'Тест' },
  image: 'https://placehold.co/200',
  phone: '+998900000402',
  address: 'QR test address 2',
  location: { type: 'Point', coordinates: [69.24, 41.30] },
  isOperational: true,
  workingHours: [{ days: ['Monday'], from: '08:00', to: '22:00' }],
  services: [],
});

const res = await fetch(`${BASE}/superadmin/shops/${shop._id}/qr-link`, { headers });
const data = await res.json();
assert(res.status === 200, `qr-link returns 200 — got ${res.status} ${JSON.stringify(data)}`);
assert(data.url === `https://t.me/SmartChairNamanganbot/SmartChair?startapp=shop_${shop._id}`, `qr-link URL is exactly right — got "${data.url}"`);

const res2 = await fetch(`${BASE}/superadmin/shops/${shop._id}/qr-link`, { headers });
const data2 = await res2.json();
assert(res2.status === 200 && data2.url === data.url, 'a second call (cached getBotUsername) returns the same URL');

// cleanup
await ServicesModel.deleteOne({ _id: shop._id });
await SuperAdmin.deleteOne({ telegramId: FAKE_SUPERADMIN_ID });

console.log(failures === 0 ? '\n🎉 ALL PASSED' : `\n💥 ${failures} FAILURE(S)`);
await mongoose.disconnect();
process.exit(failures === 0 ? 0 : 1);
