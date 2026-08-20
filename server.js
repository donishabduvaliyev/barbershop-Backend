import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import { startBot } from './config/telegramBot.js';
import shopRoutes from './routes/shops.js';
import userRouter from './routes/userData.js';
import authRouter from './routes/auth.js';
import { startReminderJob } from './jobs/reminders.js';

dotenv.config();

// Last-resort safety net: a single failed Telegram API call (e.g. messaging
// a chat id that was never real, or a user who blocked the bot) must never
// take the whole server down. Log it and keep serving requests.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
    origin: 'https://barbershop-telegram-bot.netlify.app',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedheaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Barbershop Booking API is running...');
});

app.use('/api/shops', shopRoutes);
app.use('/api/user', userRouter);
app.use('/api/auth', authRouter);

mongoose.connect(process.env.MONGO_URI, {
}).then(() => {
    console.log('✅ MongoDB connected');
    startBot();
    startReminderJob();
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}).catch((err) => {
    console.error('❌ MongoDB connection error:', err);
});
