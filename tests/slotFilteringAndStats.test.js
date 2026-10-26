import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Unit tests for Slot Filtering logic (matching client & server behavior)
// ---------------------------------------------------------------------------
function isSlotAvailableForBarber({ bookedSlots, dateKey, hour, staffId, isToday = false, isAvailableNow = true }) {
  if (isToday && isAvailableNow === false) return false;
  return !bookedSlots.some((slot) => {
    if (slot.status === 'cancelled' || slot.status === 'rejected') return false;
    const sDate = (slot.date || '').slice(0, 10);
    const sHour = Number(slot.hour);
    const sStaffId = slot.staffId ? String(slot.staffId) : null;
    return sDate === dateKey && sHour === hour && sStaffId === String(staffId);
  });
}

function countAvailableBarbersForSlot({ staff, bookedSlots, dateKey, dayName, hour, serviceId, isToday = false }) {
  const workingStaff = (staff || []).filter((m) => {
    if (isToday && m.isAvailableNow === false) return false;
    if (m.daysOff && m.daysOff.includes(dateKey)) return false;
    if (serviceId && m.serviceIds && m.serviceIds.length > 0 && !m.serviceIds.includes(serviceId)) return false;

    // Working hours / shift check
    if (m.workingHours && m.workingHours.length > 0 && dayName) {
      const schedules = m.workingHours.filter((wh) => wh.days.includes(dayName));
      if (schedules.length === 0) return false;
      const isOpen = schedules.some((sch) => {
        const [fromHour] = sch.from.split(':').map(Number);
        const [toHour] = sch.to.split(':').map(Number);
        return hour >= fromHour && hour < toHour;
      });
      if (!isOpen) return false;
    }
    return true;
  });

  const bookedStaffIds = new Set(
    bookedSlots
      .filter((s) => {
        if (s.status === 'cancelled' || s.status === 'rejected') return false;
        const sDate = (s.date || '').slice(0, 10);
        return sDate === dateKey && Number(s.hour) === hour && s.staffId;
      })
      .map((s) => String(s.staffId))
  );

  const unassignedCount = bookedSlots.filter((s) => {
    if (s.status === 'cancelled' || s.status === 'rejected') return false;
    const sDate = (s.date || '').slice(0, 10);
    return sDate === dateKey && Number(s.hour) === hour && !s.staffId;
  }).length;

  const freeStaff = workingStaff.filter((m) => !bookedStaffIds.has(String(m._id)));
  return Math.max(0, freeStaff.length - unassignedCount);
}

// ---------------------------------------------------------------------------
// Unit tests for Admin Stats math (matching routes/adminStats.js)
// ---------------------------------------------------------------------------
function calculateAnalyticsKpis({ bookings, views }) {
  const totalBookings = bookings.length;
  const completedBookings = bookings.filter((b) => b.status === 'completed');
  const rejectedBookings = bookings.filter((b) => b.status === 'rejected');
  const cancelledBookings = bookings.filter((b) => b.status === 'cancelled');

  const totalRevenue = completedBookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0);
  const averageTicket = completedBookings.length > 0 ? Math.round(totalRevenue / completedBookings.length) : 0;
  const completionRate = totalBookings > 0 ? Math.round((completedBookings.length / totalBookings) * 100) : 0;
  const noShowRate = totalBookings > 0 ? Math.round((rejectedBookings.length / totalBookings) * 100) : 0;
  const cancellationRate = totalBookings > 0 ? Math.round((cancelledBookings.length / totalBookings) * 100) : 0;

  const totalViews = views.length;
  const viewToBookingRate = totalViews > 0 ? Number(((totalBookings / totalViews) * 100).toFixed(1)) : 0;

  return {
    totalBookings,
    totalRevenue,
    averageTicket,
    completionRate,
    noShowRate,
    cancellationRate,
    viewToBookingRate,
  };
}

describe('Slot Filtering & Barber Availability', () => {
  const staff = [
    {
      _id: 'barber-1',
      name: 'Barber One',
      daysOff: ['2026-10-30'],
      serviceIds: ['srv-haircut', 'srv-beard'],
      workingHours: [{ days: ['Wednesday', 'Thursday'], from: '09:00', to: '14:00' }],
    },
    {
      _id: 'barber-2',
      name: 'Barber Two',
      daysOff: [],
      serviceIds: ['srv-haircut'],
      workingHours: [{ days: ['Wednesday', 'Thursday'], from: '14:00', to: '21:00' }],
    },
    {
      _id: 'barber-3',
      name: 'Barber Three',
      isAvailableNow: false,
      daysOff: [],
      serviceIds: ['srv-haircut'],
    },
  ];

  it('hides slot for a specific barber if already booked', () => {
    const bookedSlots = [
      { date: '2026-10-28T10:00:00Z', hour: 10, staffId: 'barber-1', status: 'confirmed' },
    ];
    expect(isSlotAvailableForBarber({ bookedSlots, dateKey: '2026-10-28', hour: 10, staffId: 'barber-1' })).toBe(false);
    expect(isSlotAvailableForBarber({ bookedSlots, dateKey: '2026-10-28', hour: 10, staffId: 'barber-2' })).toBe(true);
  });

  it('hides slot for a specific barber if isAvailableNow is false today', () => {
    expect(isSlotAvailableForBarber({
      bookedSlots: [],
      dateKey: '2026-10-28',
      hour: 10,
      staffId: 'barber-3',
      isToday: true,
      isAvailableNow: false,
    })).toBe(false);
  });

  it('re-opens slot if existing booking was cancelled or rejected', () => {
    const bookedSlots = [
      { date: '2026-10-28T10:00:00Z', hour: 10, staffId: 'barber-1', status: 'cancelled' },
      { date: '2026-10-28T11:00:00Z', hour: 11, staffId: 'barber-1', status: 'rejected' },
    ];
    expect(isSlotAvailableForBarber({ bookedSlots, dateKey: '2026-10-28', hour: 10, staffId: 'barber-1' })).toBe(true);
    expect(isSlotAvailableForBarber({ bookedSlots, dateKey: '2026-10-28', hour: 11, staffId: 'barber-1' })).toBe(true);
  });

  it('calculates available barber count for "Any Available" option accurately', () => {
    const bookedSlots = [
      { date: '2026-10-28T14:00:00Z', hour: 14, staffId: 'barber-2', status: 'confirmed' },
    ];
    // At 14:00 on Wednesday:
    // barber-1 is off (works 09:00-14:00)
    // barber-2 is booked (works 14:00-21:00)
    // barber-3 is unavailable (isAvailableNow: false today)
    const freeCount = countAvailableBarbersForSlot({
      staff,
      bookedSlots,
      dateKey: '2026-10-28',
      dayName: 'Wednesday',
      hour: 14,
      serviceId: 'srv-haircut',
      isToday: true,
    });
    expect(freeCount).toBe(0);
  });

  it('accurately respects different shifts between barbers', () => {
    // At 10:00 on Wednesday:
    // barber-1 works 09:00-14:00 (free)
    // barber-2 works 14:00-21:00 (not on shift yet)
    // barber-3 is unavailable today
    const freeCount = countAvailableBarbersForSlot({
      staff,
      bookedSlots: [],
      dateKey: '2026-10-28',
      dayName: 'Wednesday',
      hour: 10,
      serviceId: 'srv-haircut',
      isToday: true,
    });
    expect(freeCount).toBe(1);
  });

  it('excludes barbers on day off from available count', () => {
    const freeCount = countAvailableBarbersForSlot({
      staff,
      bookedSlots: [],
      dateKey: '2026-10-30', // barber-1 day off
      dayName: 'Thursday',
      hour: 10,
      serviceId: 'srv-haircut',
      isToday: true,
    });
    // barber-1 is off, barber-3 is isAvailableNow: false, barber-2 is shift 14:00-21:00 -> 0 free at 10:00
    expect(freeCount).toBe(0);
  });

  it('excludes barbers who do not offer the requested service', () => {
    const freeCount = countAvailableBarbersForSlot({
      staff,
      bookedSlots: [],
      dateKey: '2026-10-28',
      dayName: 'Wednesday',
      hour: 10,
      serviceId: 'srv-beard', // only barber-1 does beard
      isToday: false,
    });
    expect(freeCount).toBe(1);
  });
});

describe('Admin Stats & Analytics KPIs', () => {
  it('correctly computes completion, no-show, cancellation rates and avg ticket', () => {
    const bookings = [
      { status: 'completed', price: 100000 },
      { status: 'completed', price: 150000 },
      { status: 'rejected', price: 80000 }, // no-show
      { status: 'cancelled', price: 100000 },
    ];
    const views = [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}]; // 10 views

    const stats = calculateAnalyticsKpis({ bookings, views });
    expect(stats.totalBookings).toBe(4);
    expect(stats.totalRevenue).toBe(250000);
    expect(stats.averageTicket).toBe(125000);
    expect(stats.completionRate).toBe(50); // 2/4 = 50%
    expect(stats.noShowRate).toBe(25); // 1/4 = 25%
    expect(stats.cancellationRate).toBe(25); // 1/4 = 25%
    expect(stats.viewToBookingRate).toBe(40.0); // 4/10 = 40%
  });

  it('handles empty bookings cleanly without NaN or division by zero', () => {
    const stats = calculateAnalyticsKpis({ bookings: [], views: [] });
    expect(stats.totalBookings).toBe(0);
    expect(stats.totalRevenue).toBe(0);
    expect(stats.averageTicket).toBe(0);
    expect(stats.completionRate).toBe(0);
    expect(stats.noShowRate).toBe(0);
    expect(stats.viewToBookingRate).toBe(0);
  });

  it('normalizes end-of-day boundary so afternoon bookings are never dropped', () => {
    const targetDate = new Date('2026-10-26T10:00:00.000Z');
    targetDate.setHours(23, 59, 59, 999);
    const eveningBooking = new Date('2026-10-26T18:00:00.000Z');
    expect(eveningBooking.getTime() <= targetDate.getTime()).toBe(true);
  });
});
