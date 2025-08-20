
import express from 'express';
import User from '../models/userdata.js';
// import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';


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



router.patch('/bookings/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const bookingToCancel = await Booking.findById(id);

        if (!bookingToCancel) {
            return res.status(404).json({ message: 'Booking not found.' });
        }

        if (!['pending', 'confirmed'].includes(bookingToCancel.status)) {
            return res.status(400).json({ message: 'This booking can no longer be cancelled.' });
        }

        bookingToCancel.status = 'cancelled';
        await bookingToCancel.save();

        res.status(200).json(bookingToCancel);

    } catch (error) {
        console.error('Error cancelling booking:', error);
        res.status(500).json({ message: 'Server error while cancelling booking.' });
    }
});



export default router;