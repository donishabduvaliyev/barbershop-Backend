import Booking from '../models/bookingHistory.js';
import JobLock from '../models/jobLock.js';
import { sendReminder } from '../config/telegramBot.js';
import { completeBooking } from '../services/bookingActions.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const COMPLETION_GRACE_MS = 30 * 60 * 1000; // treat as completed 30 min after the slot
const LOCK_ID = 'reminderSweep';

// Mongo-based mutual exclusion so this sweep is safe to run from more than
// one server instance at once (auto-scaling, or a second local run without
// DISABLE_TELEGRAM_POLLING) without sending every reminder/rating-request
// twice. The upsert only succeeds if no lock exists yet or the previous one
// has expired; a losing instance hits a duplicate-key error and just skips
// this tick — no explicit unlock needed, it expires on its own.
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
    console.error('Reminder job lock acquisition failed:', err);
    return false;
  }
}

// Sends the 24h-before and 3h-before reminders, and rolls confirmed bookings
// whose time has passed into 'completed' + kicks off the rating request.
// Each of these three actions is idempotent per booking (guarded by its own
// boolean flag) so a slow tick, a missed tick, or a server restart can never
// double-send anything.
async function runReminderSweep() {
  const gotLock = await acquireLock(CHECK_INTERVAL_MS);
  if (!gotLock) return;

  const now = new Date();

  try {
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const due24h = await Booking.find({
      status: 'confirmed',
      reminded24h: false,
      requestedTime: { $gt: now, $lte: in24h },
    });
    for (const booking of due24h) {
      await sendReminder(booking, 'tomorrow');
      booking.reminded24h = true;
      await booking.save();
    }
  } catch (err) {
    console.error('Reminder sweep (24h) failed:', err);
  }

  try {
    const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const due3h = await Booking.find({
      status: 'confirmed',
      reminded3h: false,
      requestedTime: { $gt: now, $lte: in3h },
    });
    for (const booking of due3h) {
      await sendReminder(booking, 'in a few hours');
      booking.reminded3h = true;
      await booking.save();
    }
  } catch (err) {
    console.error('Reminder sweep (3h) failed:', err);
  }

  try {
    const completionCutoff = new Date(now.getTime() - COMPLETION_GRACE_MS);
    const toComplete = await Booking.find({
      status: 'confirmed',
      requestedTime: { $lte: completionCutoff },
    });
    for (const booking of toComplete) {
      await completeBooking(booking._id);
    }
  } catch (err) {
    console.error('Completion sweep failed:', err);
  }
}

let intervalHandle = null;

export function startReminderJob() {
  if (intervalHandle) return;
  runReminderSweep(); // catch anything due immediately on boot
  intervalHandle = setInterval(runReminderSweep, CHECK_INTERVAL_MS);
}
