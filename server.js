// Must be set before anything else touches Date — every working-hours,
// days-off, and "is this slot today" check in this codebase uses the
// process's local timezone (getHours/getMonth/toLocaleDateString without an
// explicit timeZone). Shops and customers are all in Uzbekistan, but the
// host (Render) defaults to UTC, which silently shifted every booking check
// by 5 hours and rejected genuinely-open, unbooked morning slots as
// "outside working hours".
process.env.TZ = 'Asia/Tashkent';

import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import { Server } from 'socket.io';
import { startBot } from './config/telegramBot.js';
import { startShopControlBot } from './config/shopControlBot.js';
import { verifyAdminToken } from './middleware/adminAuth.js';
import { verifyTelegramInitData, verifyMobileCustomerToken } from './middleware/telegramAuth.js';
import { setIO } from './config/socket.js';
import shopRoutes from './routes/shops.js';
import userRouter from './routes/userData.js';
import authRouter from './routes/auth.js';
import adminAuthRouter from './routes/adminAuth.js';
import adminShopRouter from './routes/adminShop.js';
import adminAppointmentsRouter from './routes/adminAppointments.js';
import adminStatsRouter from './routes/adminStats.js';
import adminCustomersRouter from './routes/adminCustomers.js';
import adminPromotionsRouter from './routes/adminPromotions.js';
import superAdminRouter from './routes/superAdmin.js';
import superAdminCategoriesRouter from './routes/superAdminCategories.js';
import superAdminReviewsRouter from './routes/superAdminReviews.js';
import trackRouter from './routes/track.js';
import webRouter from './routes/web/index.js';
import mobileRouter from './routes/mobile/index.js';
import { startReminderJob } from './jobs/reminders.js';
import { startWinBackJob } from './jobs/winBack.js';
import { startPendingBookingSweepJob } from './jobs/pendingBookingSweep.js';
import { startBackupJob } from './jobs/backup.js';
import { initErrorTracking, captureError } from './config/errorTracking.js';

dotenv.config();
initErrorTracking();

// Last-resort safety net: a single failed Telegram API call (e.g. messaging
// a chat id that was never real, or a user who blocked the bot) must never
// take the whole server down. Log it and keep serving requests.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
    captureError(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    captureError(err, { source: 'uncaughtException' });
});

const app = express();
const PORT = process.env.PORT || 5000;

import rateLimit from 'express-rate-limit';

const allowedOrigins = [
    'https://barbershop-telegram-bot.netlify.app',
    'https://admin-healthcare-namangan.netlify.app',
    process.env.ADMIN_PANEL_URL,
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'http://localhost:8081',
    'http://localhost:19006',
].filter(Boolean);

const authRateLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests, please try again in a few minutes.' },
});

// Basic HTTP Security Headers
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use(cors({
    // Native mobile apps (React Native / OkHttp / CFNetwork) send no Origin
    // header (!origin), which is allowed automatically while web origins are
    // checked against allowedOrigins.
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        if (process.env.NODE_ENV !== 'production') {
            if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /\.ngrok(-free)?\.app$/.test(origin)) {
                return callback(null, true);
            }
        }
        return callback(new Error('Blocked by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-telegram-init-data',
        'x-mobile-token',
        'x-client-platform',
        'ngrok-skip-browser-warning',
    ],
}));

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Barbershop Booking API is running (Web & Mobile Unified)...');
});

// Split Backend Modules:
// 1. /api/web/*    -> Dedicated Telegram Mini App (Web) module
// 2. /api/mobile/* -> Dedicated React Native (Android & iOS) module
app.use('/api/web', webRouter);
app.use('/api/mobile', mobileRouter);

// Root customer routes (automatically switch between Web initData and Mobile Bearer JWT)
app.use('/api/shops', shopRoutes);
app.use('/api/user', userRouter);
app.use('/api/auth', authRateLimiter, authRouter);
app.use('/api/admin/auth', authRateLimiter, adminAuthRouter);
app.use('/api/admin/shop', adminShopRouter);
app.use('/api/admin/appointments', adminAppointmentsRouter);
app.use('/api/admin/stats', adminStatsRouter);
app.use('/api/admin/customers', adminCustomersRouter);
app.use('/api/admin/promotions', adminPromotionsRouter);
app.use('/api/superadmin', superAdminRouter);
app.use('/api/superadmin/categories', superAdminCategoriesRouter);
app.use('/api/superadmin/reviews', superAdminReviewsRouter);
app.use('/api/track', trackRouter);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: true, methods: ['GET', 'POST'] },
});

// Unified Real-Time Socket.io Auth:
// Supports:
// 1. Shop Admin Panel (`auth.token` = admin JWT) -> joins `shop:<shopId>`
// 2. Mobile Customer (`auth.mobileToken` = customer JWT) -> joins `user:<telegramId>`
// 3. Web Mini App Customer (`auth.initData` = Telegram HMAC initData) -> joins `user:<telegramId>`
// 4. Pre-login Mobile Handshake (`auth.authSessionToken`) -> joins `auth:<sessionToken>`
// 5. Public Shop Availability Watcher (`auth.public = true`) -> can watch `public:shop:<shopId>`
io.use((socket, next) => {
    const auth = socket.handshake.auth || {};

    // 1. Admin panel token
    if (auth.token) {
        const payload = verifyAdminToken(auth.token);
        if (!payload || !payload.shopId) return next(new Error('Unauthorized'));
        socket.clientRole = 'admin';
        socket.shopId = payload.shopId;
        return next();
    }

    // 2. Mobile app customer JWT
    if (auth.mobileToken) {
        const mobileUser = verifyMobileCustomerToken(auth.mobileToken);
        if (!mobileUser) return next(new Error('Unauthorized'));
        socket.clientRole = 'customer';
        socket.clientPlatform = 'mobile';
        socket.telegramId = String(mobileUser.id);
        return next();
    }

    // 3. Web Mini App customer initData
    if (auth.initData) {
        const tgUser = verifyTelegramInitData(auth.initData, process.env.TELEGRAM_BOT_TOKEN);
        if (!tgUser) return next(new Error('Unauthorized'));
        socket.clientRole = 'customer';
        socket.clientPlatform = 'web';
        socket.telegramId = String(tgUser.id);
        return next();
    }

    // 4. Pre-login mobile Telegram deep-link auth session watcher
    if (auth.authSessionToken && /^[a-f0-9]{32}$/.test(auth.authSessionToken)) {
        socket.clientRole = 'auth_watcher';
        socket.authSessionToken = auth.authSessionToken;
        return next();
    }

    // 5. Public availability watcher (for browsing shops before logging in)
    if (auth.public === true) {
        socket.clientRole = 'public';
        return next();
    }

    return next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
    if (socket.clientRole === 'admin' && socket.shopId) {
        socket.join(`shop:${socket.shopId}`);
    } else if (socket.clientRole === 'customer' && socket.telegramId) {
        socket.join(`user:${socket.telegramId}`);
    } else if (socket.clientRole === 'auth_watcher' && socket.authSessionToken) {
        socket.join(`auth:${socket.authSessionToken}`);
    }

    // Allow both Web and Mobile customers to subscribe to live slot updates
    // for the shop they currently have open on screen.
    if (socket.clientRole === 'customer' || socket.clientRole === 'public') {
        socket.on('watch:shop', (shopId) => {
            if (typeof shopId === 'string' && /^[a-f0-9]{24}$/i.test(shopId)) {
                socket.join(`public:shop:${shopId}`);
            }
        });
        socket.on('unwatch:shop', (shopId) => {
            if (typeof shopId === 'string' && /^[a-f0-9]{24}$/i.test(shopId)) {
                socket.leave(`public:shop:${shopId}`);
            }
        });
    }
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
        // Also skip the reminder sweep and win-back job — both send real
        // messages based on real booking data, so a second local instance
        // running them alongside production would double-send.
        console.log('ℹ️ DISABLE_TELEGRAM_POLLING=true — skipping bot polling and the reminder/win-back jobs.');
    } else {
        startBot();
        startShopControlBot();
        startReminderJob();
        startWinBackJob();
        startPendingBookingSweepJob();
        startBackupJob();
    }
    httpServer.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}).catch((err) => {
    console.error('❌ MongoDB connection error:', err);
});
