import express from 'express';
import ServicesModel from '../models/shopData.js';
import { verifyTelegramInitData } from '../middleware/telegramAuth.js';
import { signAdminToken } from '../middleware/adminAuth.js';

const router = express.Router();

// The admin panel is opened as a Telegram Mini App from the shop-control
// bot's "Open Dashboard" button, so it carries the same signed initData the
// customer app already trusts — just verified against the shop-control
// bot's own token, since Telegram signs initData per-bot.
router.post('/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    const user = verifyTelegramInitData(initData, process.env.SHOP_CONTROL_BOT_TOKEN);
    if (!user) {
      return res.status(401).json({ message: 'Please open this dashboard from the Tezkor Shop Control bot.' });
    }

    const shop = await ServicesModel.findOne({ ownerTelegramId: user.id });
    if (!shop) {
      return res.status(403).json({ message: 'No shop is linked to this Telegram account yet. Send /claim in the bot first.' });
    }

    const token = signAdminToken({ telegramId: user.id, shopId: shop._id.toString() });
    res.status(200).json({
      token,
      shop: { id: shop._id, name: shop.name, image: shop.image },
    });
  } catch (error) {
    console.error('Admin telegram auth error:', error);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

// Lets the panel be exercised without a live Telegram client during
// development. Disabled entirely outside development.
if (process.env.NODE_ENV !== 'production') {
  router.post('/dev-login', async (req, res) => {
    try {
      const { shopId } = req.body;
      const shop = shopId ? await ServicesModel.findById(shopId) : await ServicesModel.findOne({});
      if (!shop) {
        return res.status(404).json({ message: 'No shop found to log into.' });
      }

      const token = signAdminToken({ telegramId: shop.ownerTelegramId || 0, shopId: shop._id.toString() });
      res.status(200).json({
        token,
        shop: { id: shop._id, name: shop.name, image: shop.image },
      });
    } catch (error) {
      console.error('Dev login error:', error);
      res.status(500).json({ message: 'Server error during dev login.' });
    }
  });
}

export default router;
