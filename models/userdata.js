import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    name: String,
    username: String,
    phone: String,
    email: String,
    avatar: String,
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServicesModel' }],
}, { timestamps: true });

export default mongoose.model('User', userSchema, 'user-data-barbershop');
