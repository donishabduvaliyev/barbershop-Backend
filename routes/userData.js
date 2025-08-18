
import express from 'express';
import User from '../models/userdata.js';
// import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';


const router = express.Router();


router.post('/get-user', async (req, res) => {
    try {
        const { id } = req.body; // Telegram user ID from frontend

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
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error retrieving user' });
    }
});


router.get('/profile/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;

        // Use Promise.all to fetch user details and their bookings in parallel for efficiency
        const [user, bookings] = await Promise.all([
            // 1. Find the user's personal info
            User.findOne({ telegramId: telegramId }),

            // 2. Find all bookings linked to that user's ID
            Booking.find({ userTelegramId: telegramId })
                .sort({ createdAt: -1 }) // Show the most recent bookings first
                .populate('shopId', 'name image') // Also fetch the name and image of the booked shop
        ]);

        // Check if the user exists
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // 3. Combine the results into a single response
        res.status(200).json({
            user: user,
            bookings: bookings,
        });

    } catch (error) {
        console.error('Error fetching profile data:', error);
        res.status(500).json({ message: 'Server error while fetching profile data.' });
    }
});



export default router;