import express from 'express';
import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import User from '../../models/userdata.js';
import Booking from '../../models/bookingHistory.js';
import Review from '../../models/review.js';
import ServicesModel from '../../models/shopData.js';
import MobileAuthSession from '../../models/mobileAuthSession.js';
import SuperAdmin from '../../models/superAdmin.js';
import { signAdminToken, signSuperAdminToken } from '../../middleware/adminAuth.js';
import {
  requireTelegramAuth,
  verifyTelegramInitData,
  signMobileCustomerToken,
} from '../../middleware/telegramAuth.js';
import { getBotUsername } from '../../config/telegramBot.js';
import { emitToUser, emitToShop } from '../../config/socket.js';
import { normalizeLanguage } from '../../utils/botMessages.js';
import shopRoutes from '../shops.js';
import userRouter from '../userData.js';

const router = express.Router();

const mobileAuthStartLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Please try again shortly.' },
});

const mobileReviewLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.telegramUser?.id?.toString() || ipKeyGenerator(req.ip),
  message: { message: 'Too many reviews submitted. Please try again later.' },
});

router.use((req, _res, next) => {
  req.clientPlatform = 'mobile';
  next();
});

// ---------------------------------------------------------------------------
// 1. TELEGRAM BOT DEEP-LINK AUTH FOR 3RD-PARTY MOBILE APP (ANDROID & iOS)
// ---------------------------------------------------------------------------

// Step 1: Mobile app requests a new login session token and receives the
// native `tg://resolve` deep link + fallback `https://t.me` link.
router.post('/auth/telegram/start', mobileAuthStartLimiter, async (req, res) => {
  try {
    const { deviceName = '', platform = 'android' } = req.body || {};
    const sessionToken = crypto.randomBytes(16).toString('hex'); // 32 hex chars

    await MobileAuthSession.create({
      sessionToken,
      status: 'pending',
      deviceName: String(deviceName).slice(0, 100),
      platform: ['android', 'ios'].includes(platform) ? platform : 'android',
    });

    let botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
    if (!botUsername) {
      try {
        botUsername = await getBotUsername();
      } catch {
        botUsername = 'SmartChairBot';
      }
    }

    const startParam = `login_${sessionToken}`;
    const tgDeepLink = `tg://resolve?domain=${botUsername}&start=${startParam}`;
    const webDeepLink = `https://t.me/${botUsername}?start=${startParam}`;

    res.status(201).json({
      sessionToken,
      botUsername,
      tgDeepLink,
      webDeepLink,
      expiresInSeconds: 600,
    });
  } catch (error) {
    console.error('Error starting mobile Telegram auth session:', error);
    res.status(500).json({ message: 'Failed to start Telegram login session.' });
  }
});

// Step 2: Mobile app polls this endpoint when returning from the Telegram app
// (in addition to listening on Socket.io room `auth:<sessionToken>`).
router.get('/auth/telegram/status/:sessionToken', async (req, res) => {
  try {
    const { sessionToken } = req.params;
    if (!/^[a-f0-9]{32}$/.test(sessionToken)) {
      return res.status(400).json({ message: 'Invalid session token.' });
    }

    const session = await MobileAuthSession.findOne({ sessionToken });
    if (!session) {
      return res.status(404).json({ status: 'expired', message: 'Login session expired.' });
    }

    if (session.status === 'pending' || !session.telegramId) {
      return res.status(200).json({ status: 'pending' });
    }

    const user = await User.findOne({ telegramId: session.telegramId });
    if (!user) {
      return res.status(404).json({ status: 'expired', message: 'User not found.' });
    }

    if (session.status !== 'consumed') {
      session.status = 'consumed';
      await session.save();
    }

    const token = signMobileCustomerToken({
      telegramId: user.telegramId,
      username: user.username,
      name: user.name,
    });

    return res.status(200).json({
      status: 'authenticated',
      token,
      user: {
        telegramId: user.telegramId,
        name: user.name,
        username: user.username,
        phone: user.phone || '',
        email: user.email || '',
        avatar: user.avatar || '',
        favorites: user.favorites || [],
        language: user.language || 'uz',
      },
    });
  } catch (error) {
    console.error('Error checking mobile Telegram auth status:', error);
    res.status(500).json({ message: 'Server error checking login status.' });
  }
});

// Direct verification if the mobile app passes signed Telegram initData
router.post('/auth/telegram/verify', async (req, res) => {
  try {
    const { initData } = req.body || {};
    const tgUser = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!tgUser) {
      return res.status(401).json({ message: 'Invalid Telegram authentication data.' });
    }

    const telegramIdStr = String(tgUser.id);
    const fullName = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim();

    const user = await User.findOneAndUpdate(
      { telegramId: telegramIdStr },
      {
        $set: {
          name: fullName,
          username: tgUser.username || '',
          lastPlatform: 'mobile',
        },
      },
      { new: true, upsert: true }
    );

    const token = signMobileCustomerToken({
      telegramId: user.telegramId,
      username: user.username,
      name: user.name,
    });

    res.status(200).json({
      token,
      user: {
        telegramId: user.telegramId,
        name: user.name,
        username: user.username,
        phone: user.phone || '',
        email: user.email || '',
        avatar: user.avatar || '',
        favorites: user.favorites || [],
        language: user.language || 'uz',
      },
    });
  } catch (error) {
    console.error('Error verifying mobile Telegram initData:', error);
    res.status(500).json({ message: 'Server error during authentication.' });
  }
});

// ---------------------------------------------------------------------------
// 2. MOBILE PROFILE, SYNC & IN-APP REVIEWS
// ---------------------------------------------------------------------------

// Get current authenticated customer profile + bookings + reviews in one call
router.get('/me', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);
    const [user, bookings] = await Promise.all([
      User.findOne({ telegramId }),
      Booking.find({ userTelegramId: Number(telegramId) })
        .sort({ createdAt: -1 })
        .populate('shopId', 'name image address category rating'),
    ]);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const reviews = await Review.find({ bookingId: { $in: bookings.map((b) => b._id) } });
    const reviewByBookingId = new Map(reviews.map((r) => [r.bookingId.toString(), r]));
    const bookingsWithReviews = bookings.map((b) => {
      const review = reviewByBookingId.get(b._id.toString());
      return {
        ...b.toObject(),
        rating: review?.rating ?? null,
        staffRating: review?.staffRating ?? null,
      };
    });

    res.status(200).json({
      platform: req.clientPlatform || 'mobile',
      user: {
        telegramId: user.telegramId,
        name: user.name,
        username: user.username,
        phone: user.phone || '',
        email: user.email || '',
        avatar: user.avatar || '',
        favorites: user.favorites || [],
        language: user.language || 'uz',
      },
      bookings: bookingsWithReviews,
    });
  } catch (error) {
    console.error('Error fetching mobile profile:', error);
    res.status(500).json({ message: 'Server error fetching profile.' });
  }
});

// Update profile details (name, phone, email, language) from the mobile app
// and broadcast live to any open Web Mini App or Mobile session.
router.patch('/me', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);
    const { name, phone, email, language } = req.body || {};

    const updates = { lastPlatform: req.clientPlatform || 'mobile' };
    if (typeof name === 'string' && name.trim()) updates.name = name.trim().slice(0, 80);
    if (typeof phone === 'string') updates.phone = phone.trim().slice(0, 30);
    if (typeof email === 'string') updates.email = email.trim().slice(0, 100);
    if (language) updates.language = normalizeLanguage(language);

    const user = await User.findOneAndUpdate(
      { telegramId },
      { $set: updates },
      { new: true, upsert: true }
    );

    const userPayload = {
      telegramId: user.telegramId,
      name: user.name,
      username: user.username,
      phone: user.phone || '',
      email: user.email || '',
      avatar: user.avatar || '',
      favorites: user.favorites || [],
      language: user.language || 'uz',
    };

    emitToUser(telegramId, 'user:updated', userPayload);
    res.status(200).json({ user: userPayload });
  } catch (error) {
    console.error('Error updating mobile profile:', error);
    res.status(500).json({ message: 'Server error updating profile.' });
  }
});

// Register native push notification token (Expo / FCM)
router.post('/push-token', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);
    const { token, platform = 'android' } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ message: 'Push token is required.' });
    }

    await User.updateOne(
      { telegramId },
      { $pull: { pushTokens: { token } } }
    );
    await User.updateOne(
      { telegramId },
      {
        $push: {
          pushTokens: {
            $each: [{ token, platform, updatedAt: new Date() }],
            $slice: -5, // Keep up to 5 recent devices per user
          },
        },
      }
    );

    res.status(200).json({ message: 'Push token registered.' });
  } catch (error) {
    console.error('Error registering push token:', error);
    res.status(500).json({ message: 'Server error registering push token.' });
  }
});

// Rate a completed booking directly inside the mobile app (syncs with the
// same Review collection used by the Telegram bot's inline rating buttons).
router.post('/reviews', requireTelegramAuth, mobileReviewLimiter, async (req, res) => {
  try {
    const { bookingId, rating, staffRating } = req.body || {};
    const stars = Number(rating);
    const staffStars = staffRating != null ? Number(staffRating) : null;

    if (!bookingId || !Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ message: 'Valid bookingId and rating (1-5) are required.' });
    }
    if (staffStars !== null && (!Number.isInteger(staffStars) || staffStars < 1 || staffStars > 5)) {
      return res.status(400).json({ message: 'staffRating must be between 1 and 5.' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (Number(booking.userTelegramId) !== Number(req.telegramUser.id)) {
      return res.status(403).json({ message: 'You can only rate your own bookings.' });
    }

    const existing = await Review.findOne({ bookingId: booking._id });
    if (existing) {
      return res.status(409).json({ message: 'You have already rated this booking.' });
    }

    const review = await Review.create({
      bookingId: booking._id,
      shopId: booking.shopId,
      userTelegramId: booking.userTelegramId,
      rating: stars,
      ...(booking.staffId && staffStars ? { staffId: booking.staffId, staffRating: staffStars } : {}),
    });

    const shop = await ServicesModel.findById(booking.shopId).select('rating reviewsCount staff');
    if (shop) {
      const newRating = (shop.rating * shop.reviewsCount + stars) / (shop.reviewsCount + 1);
      shop.rating = Math.round(newRating * 10) / 10;
      shop.reviewsCount += 1;

      if (booking.staffId && staffStars) {
        const staffMember = shop.staff?.id(booking.staffId);
        if (staffMember) {
          const newStaffRating = (staffMember.rating * staffMember.reviewsCount + staffStars) / (staffMember.reviewsCount + 1);
          staffMember.rating = Math.round(newStaffRating * 10) / 10;
          staffMember.reviewsCount += 1;
        }
      }
      await shop.save();
    }

    emitToUser(booking.userTelegramId, 'booking:rated', {
      bookingId: booking._id,
      rating: stars,
      staffRating: staffStars,
    });
    emitToShop(booking.shopId, 'review:created', review);

    res.status(201).json({ review });
  } catch (error) {
    console.error('Error submitting mobile review:', error);
    res.status(500).json({ message: 'Server error submitting review.' });
  }
});

// ---------------------------------------------------------------------------
// 3. ADMIN PRIVILEGES CHECK & INTEGRATION FOR MOBILE
// ---------------------------------------------------------------------------

// Check if the authenticated customer is a shop owner or superadmin
router.get('/admin/check', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = Number(req.telegramUser.id);
    const adminPanelUrl = process.env.ADMIN_PANEL_URL || 'https://admin-healthcare-namangan.netlify.app';

    // 1. Check SuperAdmin
    const superAdmin = await SuperAdmin.findOne({ telegramId });
    if (superAdmin) {
      const adminToken = signSuperAdminToken({ telegramId });
      return res.status(200).json({
        isAdmin: true,
        role: 'superadmin',
        adminToken,
        adminPanelUrl,
        shops: [],
      });
    }

    // 2. Check Shop Owner
    const shops = await ServicesModel.find({ ownerTelegramId: telegramId });
    if (shops.length > 0) {
      const adminToken = signAdminToken({
        telegramId,
        shopId: shops[0]._id.toString(),
      });
      return res.status(200).json({
        isAdmin: true,
        role: 'owner',
        adminToken,
        adminPanelUrl,
        shops: shops.map((s) => ({
          id: s._id.toString(),
          name: typeof s.name === 'string' ? s.name : (s.name?.uz || s.name?.ru || s.name?.en || 'Barbershop'),
          image: s.image || '',
        })),
      });
    }

    // 3. Normal customer
    return res.status(200).json({
      isAdmin: false,
      role: null,
      adminToken: null,
      adminPanelUrl,
      shops: [],
    });
  } catch (error) {
    console.error('Error checking admin status for mobile user:', error);
    res.status(500).json({ message: 'Server error checking admin privileges.' });
  }
});

// Switch active shop for multi-shop owner
router.post('/admin/switch-shop', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = Number(req.telegramUser.id);
    const { shopId } = req.body || {};
    if (!shopId) {
      return res.status(400).json({ message: 'shopId is required.' });
    }

    const shop = await ServicesModel.findOne({ _id: shopId, ownerTelegramId: telegramId });
    if (!shop) {
      return res.status(403).json({ message: 'That shop is not linked to your Telegram account.' });
    }

    const adminToken = signAdminToken({ telegramId, shopId: shop._id.toString() });
    res.status(200).json({
      adminToken,
      shop: {
        id: shop._id.toString(),
        name: typeof shop.name === 'string' ? shop.name : (shop.name?.uz || shop.name?.ru || shop.name?.en || 'Barbershop'),
        image: shop.image || '',
      },
    });
  } catch (error) {
    console.error('Error switching admin shop on mobile:', error);
    res.status(500).json({ message: 'Server error switching shop.' });
  }
});

// ---------------------------------------------------------------------------
// 4. SHARED CORE ROUTES UNDER /api/mobile/*
// ---------------------------------------------------------------------------
router.use('/shops', shopRoutes);
router.use('/user', userRouter);

export default router;
