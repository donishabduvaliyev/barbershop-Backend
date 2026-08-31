import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// A shop owner's Telegram account can own several shops (ownerTelegramId has
// no uniqueness constraint on ServicesModel), so a language choice belongs to
// the person, not any one shop — keyed by telegramId, set via the
// shop-control bot's /language command.
const OwnerPreferenceSchema = new Schema({
  telegramId: { type: Number, unique: true, required: true },
  language: { type: String, enum: ['en', 'ru', 'uz'], default: 'uz' },
}, { timestamps: true });

const OwnerPreference = model('OwnerPreference', OwnerPreferenceSchema, 'OwnerPreferences');

export default OwnerPreference;
