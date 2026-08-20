// In routes/auth.js
import express from 'express';
import User from '../models/userdata.js';
import { verifyTelegramInitData } from '../middleware/telegramAuth.js';

const router = express.Router();


router.post('/validate-telegram', async (req, res) => {
    const { initData } = req.body;

    if (!initData) {
        return res.status(400).json({ message: 'No initData provided' });
    }

    try {
        const userObject = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
        if (!userObject) {
            return res.status(401).json({ message: 'Invalid data: hash does not match' });
        }

        const user = await User.findOneAndUpdate(
            { telegramId: userObject.id.toString() },
            {
                $set: {
                    name: `${userObject.first_name || ''} ${userObject.last_name || ''}`.trim(),
                    username: userObject.username || '',
                }
            },
            { new: true, upsert: true }
        );
        res.status(200).json({ message: 'User validated successfully', user });

    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ message: 'Server error during validation' });
    }
});

export default router;