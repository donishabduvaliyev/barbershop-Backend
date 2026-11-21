import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import StaffShift from '../models/staffShift.js';
import { toDateKey } from '../utils/dateKey.js';

/**
 * Calculates staff commission, revenue share, and shift hours for a given shop and date window.
 * Respects per-booking snapshotted `staffCommission` so rate changes never rewrite history.
 * @param {string|mongoose.Types.ObjectId} shopId
 * @param {Date} fromDate
 * @param {Date} toDate
 */
export async function calculateStaffPayroll(shopId, fromDate, toDate) {
  const shop = await ServicesModel.findById(shopId).select('staff name');
  if (!shop) throw new Error('Shop not found');

  const fromKey = toDateKey(fromDate);
  // Subtract 1ms when computing inclusive calendar date key so an exclusive midnight end
  // (e.g. from dateKeyToRange) stays on the target day instead of bleeding into tomorrow.
  const toKey = toDateKey(new Date(Math.max(fromDate.getTime(), toDate.getTime() - 1)));

  // 1. Fetch completed bookings in date range
  const bookings = await Booking.find({
    shopId,
    status: 'completed',
    requestedTime: { $gte: fromDate, $lt: toDate },
  }).select('staffId staffName staffCommission price paidAmount requestedTime serviceName');

  // 2. Fetch shifts in date range
  const shifts = await StaffShift.find({
    shopId,
    date: { $gte: fromKey, $lte: toKey },
  });

  const staffMap = new Map();
  const staffList = shop.staff || [];

  for (const s of staffList) {
    const sId = String(s._id);
    staffMap.set(sId, {
      staffId: s._id,
      name: s.name,
      title: s.title || '',
      commissionRate: typeof s.commission === 'number' ? s.commission : 50,
      completedBookingsCount: 0,
      grossRevenue: 0,
      staffPayout: 0,
      shopRetained: 0,
      shiftsCount: 0,
      totalHoursWorked: 0,
      _totalWorkedMs: 0,
    });
  }

  const houseKey = 'house_unassigned';
  staffMap.set(houseKey, {
    staffId: null,
    name: 'Salon House (Unassigned)',
    title: 'General',
    commissionRate: 0,
    completedBookingsCount: 0,
    grossRevenue: 0,
    staffPayout: 0,
    shopRetained: 0,
    shiftsCount: 0,
    totalHoursWorked: 0,
    _totalWorkedMs: 0,
  });

  // Aggregate bookings per staff using snapshotted staffCommission if available
  for (const b of bookings) {
    const key = b.staffId ? String(b.staffId) : houseKey;
    let entry = staffMap.get(key);
    if (!entry) {
      entry = {
        staffId: b.staffId,
        name: b.staffName || 'Former Staff',
        title: '',
        commissionRate: typeof b.staffCommission === 'number' ? b.staffCommission : 50,
        completedBookingsCount: 0,
        grossRevenue: 0,
        staffPayout: 0,
        shopRetained: 0,
        shiftsCount: 0,
        totalHoursWorked: 0,
        _totalWorkedMs: 0,
      };
      staffMap.set(key, entry);
    }

    const price = Number(b.price ?? b.paidAmount) || 0;
    const effectiveRate = b.staffId
      ? (typeof b.staffCommission === 'number' ? b.staffCommission : entry.commissionRate)
      : 0;
    entry.completedBookingsCount += 1;
    entry.grossRevenue += price;
    const payout = Math.round(price * (effectiveRate / 100));
    entry.staffPayout += payout;
    entry.shopRetained += (price - payout);
  }

  // Aggregate shifts per staff (skip absent/unworked shifts from worked count)
  for (const shift of shifts) {
    const key = String(shift.staffId);
    const entry = staffMap.get(key);
    if (!entry) continue;

    if (shift.status !== 'absent') {
      entry.shiftsCount += 1;
      if (shift.clockIn && shift.clockOut && (shift.status === 'completed' || shift.status === 'active')) {
        const ms = new Date(shift.clockOut) - new Date(shift.clockIn);
        if (ms > 0) {
          entry._totalWorkedMs += ms;
        }
      }
    }
  }

  const staffBreakdown = Array.from(staffMap.values())
    .map(({ _totalWorkedMs, ...rest }) => ({
      ...rest,
      totalHoursWorked: Number((_totalWorkedMs / (1000 * 60 * 60)).toFixed(1)),
    }))
    .filter((entry) => entry.grossRevenue > 0 || entry.shiftsCount > 0 || entry.staffId !== null)
    .sort((a, b) => b.grossRevenue - a.grossRevenue);

  const totalGrossRevenue = staffBreakdown.reduce((sum, s) => sum + s.grossRevenue, 0);
  const totalStaffPayout = staffBreakdown.reduce((sum, s) => sum + s.staffPayout, 0);
  const totalShopRetained = totalGrossRevenue - totalStaffPayout;

  return {
    shopId,
    shopName: shop.name?.en || shop.name?.uz || 'Salon',
    period: {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      fromKey,
      toKey,
    },
    totalGrossRevenue,
    totalStaffPayout,
    totalShopRetained,
    staffBreakdown,
  };
}
