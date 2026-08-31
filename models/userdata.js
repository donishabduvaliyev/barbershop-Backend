import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    name: String,
    username: String,
    phone: String,
    email: String,
    avatar: String,
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServicesModel' }],
    // Chosen via the customer bot's /language command, or inferred from the
    // web app's booking-request `lang` field if never set explicitly — see
    // utils/botMessages.js. null = never chosen, falls back to 'uz'.
    language: { type: String, enum: ['en', 'ru', 'uz'], default: null },
}, { timestamps: true });

export default mongoose.model('User', userSchema, 'user-data-barbershop');
