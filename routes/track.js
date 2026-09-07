import express from 'express';
import PageView from '../models/pageView.js';

const router = express.Router();

// Public, unauthenticated, fire-and-forget — the customer app never awaits
// this. Deliberately minimal (see models/pageView.js): a count, not a full
// analytics product. A malformed/missing body silently no-ops rather than
// erroring, since a tracking failure must never surface to the customer.
router.post('/', async (req, res) => {
  try {
    const { type, shopId, userTelegramId } = req.body || {};
    if (type !== 'app_open' && type !== 'shop_view') {
      return res.status(204).end();
    }
    await PageView.create({
      type,
      shopId: type === 'shop_view' ? shopId : null,
      userTelegramId: userTelegramId || null,
    });
    res.status(204).end();
  } catch (error) {
    console.error('Error recording page view:', error);
    res.status(204).end();
  }
});

export default router;
