import express from 'express';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import {
  addToWaitlist,
  getShopQueue,
  updateWaitlistStatus,
} from '../services/waitlistService.js';
import { toDateKey } from '../utils/dateKey.js';
import { isValidDateKey } from '../utils/validate.js';

const router = express.Router();
router.use(requireShopAdmin);

// 1. Get active queue for shop
router.get('/', async (req, res) => {
  try {
    const date = req.query.date !== undefined ? req.query.date : toDateKey(new Date());
    if (!isValidDateKey(date)) {
      return res.status(400).json({ message: 'Invalid date format. Expected YYYY-MM-DD.' });
    }
    const queue = await getShopQueue(req.shopId, date);
    res.json({ queue, date });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to fetch waitlist' });
  }
});

// 2. Receptionist adds walk-in customer
router.post('/', async (req, res) => {
  try {
    const result = await addToWaitlist(req.shopId, req.body, { allowUnverifiedTelegramId: true });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to add to waitlist' });
  }
});

// 3. Call customer to chair
router.patch('/:id/call', async (req, res) => {
  try {
    const entry = await updateWaitlistStatus(req.shopId, req.params.id, 'called');
    res.json({ entry });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to call customer' });
  }
});

// 4. Seat customer in chair
router.patch('/:id/seat', async (req, res) => {
  try {
    const entry = await updateWaitlistStatus(req.shopId, req.params.id, 'in_chair');
    res.json({ entry });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to seat customer' });
  }
});

// 5. Complete walk-in visit
router.patch('/:id/complete', async (req, res) => {
  try {
    const entry = await updateWaitlistStatus(req.shopId, req.params.id, 'completed');
    res.json({ entry });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to complete entry' });
  }
});

// 6. Cancel or mark no-show
router.patch('/:id/cancel', async (req, res) => {
  try {
    const status = req.body?.status === 'no_show' ? 'no_show' : 'cancelled';
    const entry = await updateWaitlistStatus(req.shopId, req.params.id, status);
    res.json({ entry });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to cancel entry' });
  }
});

export default router;
