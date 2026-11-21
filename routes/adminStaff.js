import express from 'express';
import mongoose from 'mongoose';
import StaffShift from '../models/staffShift.js';
import ServicesModel from '../models/shopData.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import { calculateStaffPayroll } from '../services/staffPayrollService.js';
import { toDateKey, dateKeyToRange } from '../utils/dateKey.js';
import { isValidObjectId, isValidDateKey, sanitizeString } from '../utils/validate.js';

const router = express.Router();
router.use(requireShopAdmin);

// 1. List shifts for a date or date window
router.get('/shifts', async (req, res) => {
  try {
    const { date, from, to } = req.query;
    const filter = { shopId: new mongoose.Types.ObjectId(req.shopId) };

    if (date !== undefined) {
      if (!isValidDateKey(date)) {
        return res.status(400).json({ message: 'Invalid date format. Expected YYYY-MM-DD.' });
      }
      filter.date = date;
    } else if (from !== undefined || to !== undefined) {
      if (!isValidDateKey(from) || !isValidDateKey(to)) {
        return res.status(400).json({ message: 'Invalid from/to date format. Expected YYYY-MM-DD.' });
      }
      filter.date = { $gte: from, $lte: to };
    } else {
      filter.date = toDateKey(new Date());
    }

    const shifts = await StaffShift.find(filter).sort({ date: 1, createdAt: 1 });
    res.json({ shifts });
  } catch (err) {
    console.error('Error fetching staff shifts:', err);
    res.status(500).json({ message: 'Failed to fetch staff shifts' });
  }
});

// 2. Schedule or create a shift
router.post('/shifts', async (req, res) => {
  try {
    const { staffId, date, notes } = req.body;
    if (!isValidObjectId(staffId)) {
      return res.status(400).json({ message: 'Valid staffId is required' });
    }
    if (!isValidDateKey(date)) {
      return res.status(400).json({ message: 'Valid date (YYYY-MM-DD) is required' });
    }

    const shop = await ServicesModel.findOne({
      _id: req.shopId,
      'staff._id': new mongoose.Types.ObjectId(staffId),
    });
    if (!shop) {
      return res.status(404).json({ message: 'Staff member not found in this shop' });
    }

    const updateDoc = {
      $setOnInsert: {
        status: 'scheduled',
        clockIn: null,
        clockOut: null,
      },
    };
    if (typeof notes === 'string') {
      updateDoc.$set = { notes: sanitizeString(notes, 300) };
    }

    const shift = await StaffShift.findOneAndUpdate(
      {
        shopId: req.shopId,
        staffId: new mongoose.Types.ObjectId(staffId),
        date,
      },
      updateDoc,
      { new: true, upsert: true }
    );

    res.status(201).json({ shift });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Shift already exists for this staff member on this date' });
    }
    console.error('Error creating staff shift:', err);
    res.status(500).json({ message: 'Failed to create staff shift' });
  }
});

// 3. Clock In
router.patch('/shifts/:id/clock-in', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid shift ID' });
    }
    const shift = await StaffShift.findOne({
      _id: req.params.id,
      shopId: req.shopId,
    });
    if (!shift) {
      return res.status(404).json({ message: 'Shift not found' });
    }
    if (shift.status === 'completed') {
      return res.status(400).json({ message: 'Cannot clock in to an already completed shift' });
    }

    shift.clockIn = shift.clockIn || new Date();
    shift.status = 'active';
    await shift.save();

    res.json({ shift });
  } catch (err) {
    console.error('Error clocking in:', err);
    res.status(500).json({ message: 'Failed to clock in' });
  }
});

// 4. Clock Out
router.patch('/shifts/:id/clock-out', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid shift ID' });
    }
    const shift = await StaffShift.findOne({
      _id: req.params.id,
      shopId: req.shopId,
    });
    if (!shift) {
      return res.status(404).json({ message: 'Shift not found' });
    }
    if (!shift.clockIn) {
      return res.status(400).json({ message: 'Cannot clock out before clocking in' });
    }
    if (shift.status === 'completed') {
      return res.status(400).json({ message: 'Shift is already clocked out' });
    }

    shift.clockOut = new Date();
    shift.status = 'completed';
    await shift.save();

    res.json({ shift });
  } catch (err) {
    console.error('Error clocking out:', err);
    res.status(500).json({ message: 'Failed to clock out' });
  }
});

// 5. Update shift details / status
router.patch('/shifts/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid shift ID' });
    }
    const { status, notes } = req.body;
    const update = {};
    if (status && ['scheduled', 'active', 'completed', 'absent'].includes(status)) {
      update.status = status;
    }
    if (typeof notes === 'string') {
      update.notes = sanitizeString(notes, 300);
    }

    const shift = await StaffShift.findOneAndUpdate(
      { _id: req.params.id, shopId: req.shopId },
      { $set: update },
      { new: true }
    );
    if (!shift) {
      return res.status(404).json({ message: 'Shift not found' });
    }

    res.json({ shift });
  } catch (err) {
    console.error('Error updating shift:', err);
    res.status(500).json({ message: 'Failed to update shift' });
  }
});

// 6. Delete shift
router.delete('/shifts/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid shift ID' });
    }
    const result = await StaffShift.deleteOne({
      _id: req.params.id,
      shopId: req.shopId,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Shift not found' });
    }
    res.json({ success: true, message: 'Shift deleted' });
  } catch (err) {
    console.error('Error deleting shift:', err);
    res.status(500).json({ message: 'Failed to delete shift' });
  }
});

// 7. Get Commission & Payroll Report
router.get('/commissions', async (req, res) => {
  try {
    let fromDate;
    let toDate;

    if (req.query.date !== undefined) {
      if (!isValidDateKey(req.query.date)) {
        return res.status(400).json({ message: 'Invalid date format. Expected YYYY-MM-DD.' });
      }
      const range = dateKeyToRange(req.query.date);
      fromDate = range.start;
      toDate = range.end;
    } else if (req.query.from !== undefined || req.query.to !== undefined) {
      if (!isValidDateKey(req.query.from) || !isValidDateKey(req.query.to)) {
        return res.status(400).json({ message: 'Invalid from/to date format. Expected YYYY-MM-DD.' });
      }
      fromDate = new Date(`${req.query.from}T00:00:00`);
      toDate = new Date(`${req.query.to}T23:59:59.999`);
      if (fromDate > toDate) {
        return res.status(400).json({ message: 'from date must not be after to date' });
      }
    } else {
      const now = new Date();
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      toDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }

    const payroll = await calculateStaffPayroll(req.shopId, fromDate, toDate);
    res.json(payroll);
  } catch (err) {
    console.error('Error calculating payroll:', err);
    res.status(500).json({ message: 'Failed to calculate payroll' });
  }
});

// 8. Update staff commission percentage
router.patch('/:staffId/commission', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.staffId)) {
      return res.status(400).json({ message: 'Invalid staff ID' });
    }
    const { commission } = req.body;
    if (typeof commission !== 'number' || !Number.isFinite(commission) || commission < 0 || commission > 100) {
      return res.status(400).json({ message: 'Commission must be a percentage number between 0 and 100' });
    }

    const shop = await ServicesModel.findOneAndUpdate(
      {
        _id: req.shopId,
        'staff._id': new mongoose.Types.ObjectId(req.params.staffId),
      },
      {
        $set: { 'staff.$.commission': commission },
      },
      { new: true }
    );

    if (!shop) {
      return res.status(404).json({ message: 'Staff member not found in this shop' });
    }

    const updatedStaff = shop.staff.find((s) => String(s._id) === req.params.staffId);
    res.json({ staff: updatedStaff });
  } catch (err) {
    console.error('Error updating staff commission:', err);
    res.status(500).json({ message: 'Failed to update commission' });
  }
});

export default router;
