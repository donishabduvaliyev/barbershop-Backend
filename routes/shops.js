import express from 'express';
import User from '../models/userdata.js';

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

export default router;
