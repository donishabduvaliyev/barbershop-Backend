import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import StaffShift from '../models/staffShift.js';
import { toDateKey } from '../utils/dateKey.js';

/**
 * Calculates staff commission, revenue share, and shift hours for a given shop and date window.
 * @param {string|mongoose.Types.ObjectId} shopId 
 * @param {Date} fromDate 
 * @param {Date} toDate 
 */
export async function calculateStaffPayroll(shopId, fromDate, toDate) {
  const shop = await ServicesModel.findById(shopId).select('staff name');
  if (!shop) throw new Error('Shop not found');

  const fromKey = toDateKey(fromDate);
  const toKey = toDateKey(toDate);

  // 1. Fetch completed bookings in date range
  const bookings = await Booking.find({
    shopId,
    status: 'completed',
    requestedTime: { $gte: fromDate, $lt: toDate },
  }).select('staffId staffName price requestedTime serviceName');

  // 2. Fetch shifts in date range
  const shifts = await StaffShift.find({
    shopId,
    date: { $gte: fromKey, $lte: toKey },
  });

  // Map staff configs by string ID
  const staffMap = new Map();
  const staffList = shop.staff || [];

  for (const s of staffList) {
    const sId = String(s._id);
    staffMap.set(sId, {
      staffId: s._id,
      name: s.name,
      title: s.title || '',
      commissionRate: typeof s.commission === 'number' ? s.commission : 50, // default 50%
      completedBookingsCount: 0,
      grossRevenue: 0,
      staffPayout: 0,
      shopRetained: 0,
      shiftsCount: 0,
      totalHoursWorked: 0,
    });
  }

  // Account for house / unassigned staff (staffId = null)
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
  });

  // Aggregate bookings per staff
  for (const b of bookings) {
    const key = b.staffId ? String(b.staffId) : houseKey;
    let entry = staffMap.get(key);
    if (!entry) {
      entry = {
        staffId: b.staffId,
        name: b.staffName || 'Former Staff',
        title: '',
        commissionRate: 50,
        completedBookingsCount: 0,
        grossRevenue: 0,
        staffPayout: 0,
        shopRetained: 0,
        shiftsCount: 0,
        totalHoursWorked: 0,
      };
      staffMap.set(key, entry);
    }

    const price = Number(b.price) || 0;
    entry.completedBookingsCount += 1;
    entry.grossRevenue += price;
    const payout = Math.round(price * (entry.commissionRate / 100));
    entry.staffPayout += payout;
    entry.shopRetained += (price - payout);
  }

  // Aggregate shifts per staff
  for (const shift of shifts) {
    const key = String(shift.staffId);
    const entry = staffMap.get(key);
    if (entry) {
      entry.shiftsCount += 1;
      if (shift.clockIn && shift.clockOut) {
        const ms = new Date(shift.clockOut) - new Date(shift.clockIn);
        if (ms > 0) {
          entry.totalHoursWorked += Number((ms / (1000 * 60 * 60)).toFixed(1));
        }
      }
    }
  }

  const staffBreakdown = Array.from(staffMap.values())
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
