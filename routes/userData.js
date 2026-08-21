
import express from 'express';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import Review from '../models/review.js';
import shopControlBot from '../config/shopControlBot.js';
import { editBookingCard } from '../config/notificationBridge.js';
import { emitToShop } from '../config/socket.js';
import { requireTelegramAuth } from '../middleware/telegramAuth.js';


const router = express.Router();


router.post('/get-user', async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Telegram ID is required' });
        }

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

        res.status(200).json({ favorites: user.favorites, isFavorited: !isFavorited });
    } catch (error) {
        console.error('Error toggling favorite:', error);
        res.status(500).json({ message: 'Server error updating favorites.' });
    }
});

router.get('/favorites/:telegramId', async (req, res) => {
    try {
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


router.get('/profile/:telegramId', async (req, res) => {
    try {
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
        const bookingToCancel = await Booking.findById(id);

        if (!bookingToCancel) {
            return res.status(404).json({ message: 'Booking not found.' });
        }

        // Only the booking's own owner can cancel it — otherwise any
        // authenticated Telegram user could cancel anyone else's booking
        // just by guessing/knowing its id.
        if (Number(bookingToCancel.userTelegramId) !== Number(req.telegramUser.id)) {
            return res.status(403).json({ message: 'You can only cancel your own bookings.' });
        }

        if (!['pending', 'confirmed'].includes(bookingToCancel.status)) {
            return res.status(400).json({ message: 'This booking can no longer be cancelled.' });
        }

        bookingToCancel.status = 'cancelled';
        await bookingToCancel.save();

        // Notify the shop's own owner (not a global admin chat) that their
        // customer cancelled, and update the original Telegram card in place.
        try {
            const shop = await ServicesModel.findById(bookingToCancel.shopId).select('ownerTelegramId');
            if (shop?.ownerTelegramId) {
                const formattedTime = new Date(bookingToCancel.requestedTime).toLocaleString();
                const notificationMessage = [
                    '⚠️ *Booking Cancelled by Client*',
                    `*Shop:* ${bookingToCancel.shopName}`,
                    `*Client:* ${bookingToCancel.userName || bookingToCancel.userTelegramUsername || 'N/A'}`,
                    `*Time:* ${formattedTime}`,
                ].join('\n');
                await shopControlBot.sendMessage(shop.ownerTelegramId, notificationMessage, { parse_mode: 'Markdown' });
            }
            await editBookingCard(bookingToCancel, '⚪️ *CANCELLED BY CLIENT*');
            emitToShop(bookingToCancel.shopId, 'appointment:update', bookingToCancel);
        } catch (notificationError) {
            // Log the error but don't fail the API request.
            // The user's cancellation was successful even if the owner notification fails.
            console.error('Failed to send cancellation notification to shop owner:', notificationError);
        }

        res.status(200).json(bookingToCancel);

    } catch (error) {
        console.error('Error cancelling booking:', error);
        res.status(500).json({ message: 'Server error while cancelling booking.' });
    }
});



export default router;