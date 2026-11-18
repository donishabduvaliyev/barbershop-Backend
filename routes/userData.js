import express from 'express';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Review from '../models/review.js';
import shopControlBot from '../config/shopControlBot.js';
import { editBookingCard } from '../config/notificationBridge.js';
import { emitToShop, emitToUser } from '../config/socket.js';
import { requireTelegramAuth } from '../middleware/telegramAuth.js';
import { escapeMarkdown } from '../utils/escapeMarkdown.js';
import { cancelBooking } from '../services/bookingActions.js';


const router = express.Router();


// Requires real Telegram auth — this returns the caller's own PII (name,
// phone, email, favorites), so the id must come from verified initData,
// never a client-supplied body field (anyone could otherwise dump any
// user's profile by guessing/iterating Telegram ids).
router.post('/get-user', requireTelegramAuth, async (req, res) => {
    try {
        const id = req.telegramUser.id;

        const user = await User.findOne({ telegramId: id.toString() });

        if (!user) {
            return res.status(404).json({ message: 'User not found in database' });
        }

        res.json({
            message: 'User data retrieved successfully',
            user: {
                telegramId: user.telegramId,
                name: user.name,
                phone: user.phone,
                email: user.email,
                avatar: user.avatar,
                favorites: user.favorites || [],
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error retrieving user' });
    }
});

// Toggle a shop in the caller's favorites. Requires real Telegram auth —
// favorites are personal, so we never trust a client-supplied telegramId.
router.post('/favorites/toggle', requireTelegramAuth, async (req, res) => {
    try {
        const { shopId } = req.body;
        if (!shopId) {
            return res.status(400).json({ message: 'shopId is required' });
        }

        const telegramId = req.telegramUser.id.toString();
        const user = await User.findOne({ telegramId });
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const isFavorited = user.favorites.some((id) => id.toString() === shopId);
        if (isFavorited) {
            user.favorites = user.favorites.filter((id) => id.toString() !== shopId);
        } else {
            user.favorites.push(shopId);
        }
        await user.save();

        emitToUser(telegramId, 'favorites:updated', {
            favorites: user.favorites,
            shopId,
            isFavorited: !isFavorited,
        });

        res.status(200).json({ favorites: user.favorites, isFavorited: !isFavorited });
    } catch (error) {
        console.error('Error toggling favorite:', error);
        res.status(500).json({ message: 'Server error updating favorites.' });
    }
});

// Requires real Telegram auth — favorites are personal, same reasoning as
// POST /favorites/toggle. Only the caller's own favorites are ever
// returned, regardless of what :telegramId is in the URL.
router.get('/favorites/:telegramId', requireTelegramAuth, async (req, res) => {
    try {
        if (Number(req.params.telegramId) !== Number(req.telegramUser.id)) {
            return res.status(403).json({ message: 'You can only view your own favorites.' });
        }
        const { telegramId } = req.params;
        const user = await User.findOne({ telegramId }).populate('favorites');
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json({ favorites: user.favorites || [] });
    } catch (error) {
        console.error('Error fetching favorites:', error);
        res.status(500).json({ message: 'Server error fetching favorites.' });
    }
});


// Requires real Telegram auth — this is a full PII dump (name/phone/email
// plus every booking this person has ever made across every shop), so it
// must never be reachable for an arbitrary telegramId supplied by the caller.
router.get('/profile/:telegramId', requireTelegramAuth, async (req, res) => {
    try {
        if (Number(req.params.telegramId) !== Number(req.telegramUser.id)) {
            return res.status(403).json({ message: 'You can only view your own profile.' });
        }
        const { telegramId } = req.params;

        const [user, bookings] = await Promise.all([

            User.findOne({ telegramId: telegramId }),


            Booking.find({ userTelegramId: telegramId })
                .sort({ createdAt: -1 })
                .populate('shopId', 'name image')
        ]);

        // Check if the user exists
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Attach each booking's own rating (if the customer has responded to
        // the post-visit rating request) so history can show it read-only.
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

        // 3. Combine the results into a single response
        res.status(200).json({
            user: user,
            bookings: bookingsWithReviews,
        });

    } catch (error) {
        console.error('Error fetching profile data:', error);
        res.status(500).json({ message: 'Server error while fetching profile data.' });
    }
});



router.patch('/bookings/:id/cancel', requireTelegramAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const booking = await Booking.findOne({ _id: id, userTelegramId: req.telegramUser.id });

        if (!booking) {
            return res.status(404).json({ message: 'Booking not found.' });
        }

        if (!['pending', 'confirmed'].includes(booking.status)) {
            return res.status(400).json({ message: 'This booking can no longer be cancelled.' });
        }

        const cancelledBooking = await cancelBooking(id, 'Cancelled by client via Web App');
        emitToShop(cancelledBooking.shopId, 'appointment:update', cancelledBooking);

        return res.status(200).json(cancelledBooking);
    } catch (error) {
        console.error('Error cancelling booking:', error);
        res.status(500).json({ message: 'Server error while cancelling booking.' });
    }
});



export default router;