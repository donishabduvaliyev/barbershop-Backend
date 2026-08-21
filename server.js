import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import { Server } from 'socket.io';
import { startBot } from './config/telegramBot.js';
import { startShopControlBot } from './config/shopControlBot.js';
import { verifyAdminToken } from './middleware/adminAuth.js';
import { setIO } from './config/socket.js';
import shopRoutes from './routes/shops.js';
import userRouter from './routes/userData.js';
import authRouter from './routes/auth.js';
import adminAuthRouter from './routes/adminAuth.js';
import adminShopRouter from './routes/adminShop.js';
import adminAppointmentsRouter from './routes/adminAppointments.js';
import adminStatsRouter from './routes/adminStats.js';
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

const allowedOrigins = [
    'https://barbershop-telegram-bot.netlify.app',
    "https://admin-healthcare-namangan.netlify.app",
    process.env.ADMIN_PANEL_URL,
    'http://localhost:5173',
    'http://localhost:5174',
].filter(Boolean);

app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedheaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
}));

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Barbershop Booking API is running...');
});

app.use('/api/shops', shopRoutes);
app.use('/api/user', userRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin/auth', adminAuthRouter);
app.use('/api/admin/shop', adminShopRouter);
app.use('/api/admin/appointments', adminAppointmentsRouter);
app.use('/api/admin/stats', adminStatsRouter);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
});

// Every admin-panel socket connection must present the same JWT issued by
// /api/admin/auth — it's then auto-joined to its own shop's room, never a
// client-requested one, so one shop's tab can never subscribe to another's.
io.use((socket, next) => {
    const payload = verifyAdminToken(socket.handshake.auth?.token);
    if (!payload) return next(new Error('Unauthorized'));
    socket.shopId = payload.shopId;
    next();
});

io.on('connection', (socket) => {
    socket.join(`shop:${socket.shopId}`);
});

setIO(io);

mongoose.connect(process.env.MONGO_URI, {
}).then(() => {
    console.log('✅ MongoDB connected');
    // Both bot tokens only support one active poller each — if a production
    // deployment is already polling the same token (the usual case when
    // developing locally against the shared/live database), starting a
    // second poller here just fights it for updates. Opt out with this flag
    // when you only need the REST/Socket.io API locally.
    if (process.env.DISABLE_TELEGRAM_POLLING === 'true') {
        // Also skip the reminder sweep — it sends real messages (reminders,
        // rating requests) based on real booking data, so a second local
        // instance running it alongside production would double-send.
        console.log('ℹ️ DISABLE_TELEGRAM_POLLING=true — skipping bot polling and the reminder job.');
    } else {
        startBot();
        startShopControlBot();
        startReminderJob();
    }
    httpServer.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}).catch((err) => {
    console.error('❌ MongoDB connection error:', err);
});
