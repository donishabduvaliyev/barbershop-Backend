import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
// import bot from './config/telegramBot.js';
import './config/telegramBot.js'

// import authRoutes from './routes/auth.js';
import shopRoutes from './routes/shops.js';
import userRouter from './routes/userData.js';
// import bookingRoutes from './routes/bookings.js';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const allowedOrigins = [
    "https://barbershop-telegram-bot.netlify.app"
]

app.use(cors({
    origin: 'https://barbershop-telegram-bot.netlify.app',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middlewares
// app.use(cors({
//     origin: function (origin, callback) {
//         if (!origin || allowedOrigins.includes(origin) || origin.includes("web.telegram.org")) {
//             callback(null, true);
//         } else {
//             callback(new Error("Not allowed by CORS"));
//         }
//     },
//     methods: "GET,POST",
//     allowedHeaders: "Content-Type",
//     credentials: true
// }));
app.use(express.json());

// Test route
app.get('/', (req, res) => {
    res.send('Barbershop Booking API is running...');
});


// app.use('/api/auth', authRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/user/' , userRouter)
// app.use('/api/bookings', bookingRoutes);

// DB connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}).catch((err) => {
    console.error('❌ MongoDB connection error:', err);
});
