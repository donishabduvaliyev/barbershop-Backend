import express from 'express';
import ServicesModel from '../models/shopData.js';
import { verifyTelegramInitData } from '../middleware/telegramAuth.js';
import { signAdminToken, signIdentityToken, verifyAdminToken } from '../middleware/adminAuth.js';

const router = express.Router();

const toShopSummary = (shop) => ({ id: shop._id, name: shop.name, image: shop.image });

// The admin panel is opened as a Telegram Mini App from the shop-control
// bot's "Open Dashboard" button, so it carries the same signed initData the
// customer app already trusts — just verified against the shop-control
// bot's own token, since Telegram signs initData per-bot.
router.post('/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    const user = verifyTelegramInitData(initData, process.env.SHOP_CONTROL_BOT_TOKEN);
    if (!user) {
      return res.status(401).json({ message: 'Please open this dashboard from the  Shop Control bot.' });
    }

    const shops = await ServicesModel.find({ ownerTelegramId: user.id });
    if (shops.length === 0) {
      return res.status(403).json({ message: 'No shop is linked to this Telegram account yet. Send /claim in the bot first.' });
    }

    // One owner can manage several shops — if there's only one, skip
    // straight to a real session; otherwise the panel needs to ask which
    // shop to open before we can issue a shop-scoped token.
    if (shops.length === 1) {
      const token = signAdminToken({ telegramId: user.id, shopId: shops[0]._id.toString() });
      return res.status(200).json({ token, shop: toShopSummary(shops[0]) });
    }

    const identityToken = signIdentityToken({ telegramId: user.id });
    res.status(200).json({
      needsShopSelection: true,
      identityToken,
      shops: shops.map(toShopSummary),
    });
  } catch (error) {
    console.error('Admin telegram auth error:', error);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

// Exchanges either an identity token (multi-shop login, see /telegram above)
// or an existing shop-scoped session for a token scoped to a *different*
// shop the same Telegram account owns — this is also how an already-logged-in
// owner switches between their shops without re-verifying via Telegram.
router.post('/select-shop', async (req, res) => {
  try {
    const { token, shopId } = req.body;
    const payload = verifyAdminToken(token);
    if (!payload?.telegramId) {
      return res.status(401).json({ message: 'Please log in again.' });
    }

    const shop = await ServicesModel.findOne({ _id: shopId, ownerTelegramId: payload.telegramId });
    if (!shop) {
      return res.status(403).json({ message: 'That shop is not linked to your Telegram account.' });
    }

    const newToken = signAdminToken({ telegramId: payload.telegramId, shopId: shop._id.toString() });
    res.status(200).json({ token: newToken, shop: toShopSummary(shop) });
  } catch (error) {
    console.error('Select-shop error:', error);
    res.status(500).json({ message: 'Server error switching shops.' });
  }
});

// Lets an already-logged-in owner see every shop tied to their account, so
// the panel can offer a "switch shop" list without re-authenticating.
router.get('/my-shops', async (req, res) => {
  try {
    const payload = verifyAdminToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!payload?.telegramId) {
      return res.status(401).json({ message: 'Please log in again.' });
    }
    const shops = await ServicesModel.find({ ownerTelegramId: payload.telegramId });
    res.status(200).json({ shops: shops.map(toShopSummary) });
  } catch (error) {
    console.error('my-shops error:', error);
    res.status(500).json({ message: 'Server error fetching your shops.' });
  }
});

// Lets the panel be exercised without a live Telegram client during
// development. Off by default — deliberately opt-in (not just "not
// production") since an open ngrok tunnel or a misconfigured host without
// NODE_ENV=production would otherwise leave this reachable publicly with no
// authentication at all.
if (process.env.ADMIN_DEV_LOGIN_ENABLED === 'true' && process.env.NODE_ENV !== 'production') {
  router.post('/dev-login', async (req, res) => {
    try {
      const { shopId } = req.body;
      const shop = shopId ? await ServicesModel.findById(shopId) : await ServicesModel.findOne({});
      if (!shop) {
        return res.status(404).json({ message: 'No shop found to log into.' });
      }

      const token = signAdminToken({ telegramId: shop.ownerTelegramId || 0, shopId: shop._id.toString() });
      res.status(200).json({ token, shop: toShopSummary(shop) });
    } catch (error) {
      console.error('Dev login error:', error);
      res.status(500).json({ message: 'Server error during dev login.' });
    }
  });
}

export default router;
