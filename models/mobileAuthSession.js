import mongoose from 'mongoose';

// Short-lived handshake document for Telegram Deep-Link Auth on mobile
// (React Native Android/iOS).
// Flow:
// 1. Mobile app calls POST /api/mobile/auth/telegram/start -> creates a
//    pending session with a random 32-hex sessionToken.
// 2. Mobile app opens tg://resolve?domain=<bot>&start=login_<sessionToken>
//    and listens on Socket.io room `auth:<sessionToken>` (plus polls on
//    app foreground).
// 3. Customer taps Start in Telegram -> config/telegramBot.js marks this
//    session 'authenticated', attaches telegramId, and pushes the signed
//    JWT to the mobile app in real time.
const mobileAuthSessionSchema = new mongoose.Schema({
  sessionToken: { type: String, required: true, unique: true, index: true },
  status: {
    type: String,
    enum: ['pending', 'authenticated', 'consumed'],
    default: 'pending',
  },
  telegramId: { type: String, default: null },
  deviceName: { type: String, default: '' },
  platform: { type: String, default: 'android' },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // Auto-deletes after 10 minutes
});

export default mongoose.model('MobileAuthSession', mobileAuthSessionSchema);
