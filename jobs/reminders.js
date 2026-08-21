import Booking from '../models/bookingHistory.js';
import { sendReminder } from '../config/telegramBot.js';
import { completeBooking } from '../services/bookingActions.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const COMPLETION_GRACE_MS = 30 * 60 * 1000; // treat as completed 30 min after the slot

// Sends the 24h-before and 3h-before reminders, and rolls confirmed bookings
// whose time has passed into 'completed' + kicks off the rating request.
// Each of these three actions is idempotent per booking (guarded by its own
// boolean flag) so a slow tick, a missed tick, or a server restart can never
// double-send anything.
async function runReminderSweep() {
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
