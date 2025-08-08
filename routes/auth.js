// In routes/auth.js
import express from 'express';
import crypto from 'crypto';
import User from '../models/userdata.js';

const router = express.Router();

// @desc    Validate user data from Telegram and log them in
// @route   POST /api/auth/validate-telegram
// @access  Public
router.post('/validate-telegram', async (req, res) => {
    const { initData } = req.body;

    if (!initData) {
        return res.status(400).json({ message: 'No initData provided' });
    }

    try {
        // 1. Create a string from all received data pairs
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash'); // remove hash from the list of parameters

        // 2. Sort parameters alphabetically
        const sortedKeys = Array.from(params.keys()).sort();
        const dataCheckString = sortedKeys
            .map(key => `${key}=${params.get(key)}`)
            .join('\n');

        // 3. Create the secret key
        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(process.env.TELEGRAM_BOT_TOKEN)
            .digest();

        // 4. Calculate the hash of the data check string
        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        // 5. Compare the hashes
        if (calculatedHash !== hash) {
            return res.status(401).json({ message: 'Invalid data: hash does not match' });
        }

        // 6. If hash is valid, the data is authentic. Find or create the user.
        const userObject = JSON.parse(params.get('user'));

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

        // Optional: Generate your own session token (like a JWT) here if you want
        // For now, we'll just send back the user data.
        res.status(200).json({ message: 'User validated successfully', user });

    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ message: 'Server error during validation' });
    }
});

export default router;