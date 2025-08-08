import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    name: String,
    phone: String,
    email: String,
    avatar: String,
});

export default mongoose.model('User', userSchema, 'user-data-barbershop');
