import express from 'express';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import {
  computeShopCrmSegments,
  sendReengagementBroadcast,
} from '../services/customerCrmService.js';

const router = express.Router();
router.use(requireShopAdmin);

// 1. Get full RFM segmentation summary & ranked customer list
router.get('/segments', async (req, res) => {
  try {
    const crm = await computeShopCrmSegments(req.shopId);
    res.json({
      totalClients: crm.totalClients,
      segments: crm.segments,
      customers: crm.customers,
    });
  } catch (err) {
    console.error('Error computing CRM segments:', err);
    res.status(500).json({ message: 'Failed to compute CRM segments' });
  }
});

// 2. Get list of at-risk clients due for re-engagement
router.get('/at-risk', async (req, res) => {
  try {
    const crm = await computeShopCrmSegments(req.shopId);
    res.json({ atRiskClients: crm.atRiskClients });
  } catch (err) {
    console.error('Error fetching at-risk clients:', err);
    res.status(500).json({ message: 'Failed to fetch at-risk clients' });
  }
});

// 3. Trigger targeted win-back re-engagement broadcast
router.post('/broadcast-reengagement', async (req, res) => {
  try {
    const { messageTemplate, targetSegment, limit } = req.body;
    const rawLimit = parseInt(limit, 10);
    const safeLimit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 200));
    const result = await sendReengagementBroadcast(req.shopId, {
      messageTemplate,
      targetSegment: targetSegment || 'at_risk',
      limit: safeLimit,
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to send broadcast' });
  }
});

export default router;
