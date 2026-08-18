import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    name: String,
    username: String,
    phone: String,
    email: String,
    avatar: String,
}, { timestamps: true });

export default mongoose.model('User', userSchema, 'user-data-barbershop');
