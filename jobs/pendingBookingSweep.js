// A booking request that sits 'pending' forever is a real gap: if an owner
// never sees the Telegram notification (muted chat, dead phone, on
// vacation), the customer is left with no resolution and no idea whether to
// book elsewhere. This sweep auto-rejects a pending booking once either:
//   - it's been pending longer than PENDING_TIMEOUT_MS, or
//   - its requested time has already passed unanswered (no point holding a
//     booking open for a slot that's already gone by).
// Reuses rejectBooking so the customer/owner notifications, card edit, and
// socket update all stay identical to a manual reject — this is just what
// triggers it.
import Booking from '../models/bookingHistory.js';
import JobLock from '../models/jobLock.js';
import { rejectBooking } from '../services/bookingActions.js';
import { t, normalizeLanguage } from '../utils/botMessages.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_ID = 'pendingBookingSweep';

// Same Mongo-based mutual exclusion as jobs/reminders.js — see that file's
// comment for why this is safe across more than one server instance.
async function acquireLock(durationMs) {
  const now = new Date();
  try {
    await JobLock.findOneAndUpdate(
      { _id: LOCK_ID, lockedUntil: { $lt: now } },
      { $set: { lockedUntil: new Date(now.getTime() + durationMs) } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // another instance holds the lock
    console.error('Pending-booking sweep lock acquisition failed:', err);
    return false;
  }
}

async function runPendingBookingSweep() {
  const gotLock = await acquireLock(CHECK_INTERVAL_MS);
  if (!gotLock) return;

  const now = new Date();
  const pendingCutoff = new Date(now.getTime() - PENDING_TIMEOUT_MS);

  try {
    const expired = await Booking.find({
      status: 'pending',
      $or: [
        { createdAt: { $lte: pendingCutoff } },
        { requestedTime: { $lte: now } },
      ],
    });

    for (const booking of expired) {
      const reason = t(normalizeLanguage(booking.userLanguage), 'customer.autoExpiredReason');
      await rejectBooking(booking._id, reason);
      console.log(`⏱️ Booking ${booking._id} auto-expired — ${booking.shopName}, ${booking.userName} (was pending since ${booking.createdAt.toISOString()})`);
    }
  } catch (err) {
    console.error('Pending-booking sweep failed:', err);
  }
}

let intervalHandle = null;

export function startPendingBookingSweepJob() {
  if (intervalHandle) return;
  runPendingBookingSweep(); // catch anything already overdue on boot
  intervalHandle = setInterval(runPendingBookingSweep, CHECK_INTERVAL_MS);
}
