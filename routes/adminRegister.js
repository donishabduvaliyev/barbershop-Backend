import express from 'express';
import mongoose from 'mongoose';
import CashRegister from '../models/cashRegister.js';
import Transaction from '../models/transaction.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import {
  openRegister,
  getCurrentRegisterStatus,
  recordTransaction,
  closeRegister,
} from '../services/cashRegisterService.js';
import { isValidObjectId } from '../utils/validate.js';

const router = express.Router();
router.use(requireShopAdmin);

// 1. Get current open register & real-time summary
router.get('/current', async (req, res) => {
  try {
    const status = await getCurrentRegisterStatus(req.shopId);
    if (!status) {
      return res.json({ isOpen: false, register: null, summary: null });
    }
    res.json({ isOpen: true, ...status });
  } catch (err) {
    console.error('Error fetching register status:', err);
    res.status(500).json({ message: 'Failed to fetch register status' });
  }
});

// 2. Open a new register session
router.post('/open', async (req, res) => {
  try {
    const { openingCashBalance } = req.body;
    const register = await openRegister(
      req.shopId,
      req.telegramId,
      openingCashBalance
    );
    res.status(201).json({ register });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to open register' });
  }
});

// 3. Close register and generate Z-Report
router.post('/close', async (req, res) => {
  try {
    const { closingCashBalance, notes } = req.body;
    const result = await closeRegister(
      req.shopId,
      req.telegramId,
      closingCashBalance,
      notes
    );
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to close register' });
  }
});

// 4. Past Z-Report History
router.get('/history', async (req, res) => {
  try {
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 30, 100));
    const sessions = await CashRegister.find({
      shopId: req.shopId,
      status: 'closed',
    })
      .sort({ closedAt: -1 })
      .limit(limit);

    res.json({ sessions });
  } catch (err) {
    console.error('Error fetching register history:', err);
    res.status(500).json({ message: 'Failed to fetch register history' });
  }
});

// 5. List transactions (for current register or specific registerId)
router.get('/transactions', async (req, res) => {
  try {
    const { registerId, limit: rawLimitParam } = req.query;
    const rawLimit = parseInt(rawLimitParam, 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 500));

    const filter = { shopId: new mongoose.Types.ObjectId(req.shopId) };

    if (registerId !== undefined) {
      if (!isValidObjectId(registerId)) {
        return res.status(400).json({ message: 'Invalid registerId' });
      }
      filter.registerId = new mongoose.Types.ObjectId(registerId);
    } else {
      const current = await CashRegister.findOne({ shopId: req.shopId, status: 'open' }).select('_id');
      if (current) {
        filter.registerId = current._id;
      } else {
        return res.json({ transactions: [] });
      }
    }

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({ transactions });
  } catch (err) {
    console.error('Error fetching transactions:', err);
    res.status(500).json({ message: 'Failed to fetch transactions' });
  }
});

// 6. Record a manual payment or expense
router.post('/transactions', async (req, res) => {
  try {
    const tx = await recordTransaction(req.shopId, {
      ...req.body,
      recordedBy: req.telegramId,
    });
    res.status(201).json({ transaction: tx });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to record transaction' });
  }
});

export default router;
