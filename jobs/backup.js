// A daily application-level backup, independent of whatever MongoDB Atlas
// tier this runs on. Atlas's free/shared tiers don't include continuous
// backups — this is a real, working safety net against a bad migration
// script, an accidental deleteMany, or a bug wiping real shop/customer/
// booking data, regardless of the Atlas tier question getting resolved.
// It's a supplement to a proper Atlas backup plan, not a replacement for
// one — point-in-time recovery from Atlas is far more granular than one
// snapshot a day.
import JobLock from '../models/jobLock.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import User from '../models/userdata.js';
import Customer from '../models/customer.js';
import Review from '../models/review.js';
import Promotion from '../models/promotion.js';
import SearchCategory from '../models/searchCategory.js';
import { uploadBackup, backupsConfigured } from '../config/backupStorage.js';
import { captureError } from '../config/errorTracking.js';
import { toDateKey } from '../utils/dateKey.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const LOCK_ID = 'dailyBackup';

// Every collection worth losing sleep over — deliberately excludes
// PageView (analytics, regenerable/disposable) and JobLock (pure runtime
// bookkeeping, meaningless outside the running process).
const COLLECTIONS = [
  { name: 'shops', model: ServicesModel },
  { name: 'bookings', model: Booking },
  { name: 'users', model: User },
  { name: 'customers', model: Customer },
  { name: 'reviews', model: Review },
  { name: 'promotions', model: Promotion },
  { name: 'searchCategories', model: SearchCategory },
];

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
    console.error('Backup job lock acquisition failed:', err);
    return false;
  }
}

async function runBackup() {
  if (!backupsConfigured()) {
    console.log('ℹ️ R2_BACKUP_BUCKET_NAME not set — daily backup disabled.');
    return;
  }

  const gotLock = await acquireLock(CHECK_INTERVAL_MS);
  if (!gotLock) return;

  const dateKey = toDateKey(new Date());
  const counts = {};
  let failedCollection = null;

  for (const { name, model } of COLLECTIONS) {
    try {
      const docs = await model.find({}).lean();
      await uploadBackup(`backups/${dateKey}/${name}.json.gz`, docs);
      counts[name] = docs.length;
      console.log(`💾 Backed up ${docs.length} ${name} doc(s) → backups/${dateKey}/${name}.json.gz`);
    } catch (err) {
      console.error(`Backup failed for collection "${name}":`, err);
      captureError(err, { source: 'dailyBackup', collection: name });
      failedCollection = failedCollection || name;
      // Keep going — a failure on one collection shouldn't also skip
      // backing up the rest of the day's data.
    }
  }

  // Without this, a day whose backup partially failed looks identical in
  // shape to a fully-successful one (same directory, some files present) —
  // there's no way to tell "backup ran, all good" from "backup ran, three
  // collections silently failed" without a marker that only gets written
  // once everything else succeeded.
  try {
    await uploadBackup(`backups/${dateKey}/_manifest.json.gz`, {
      completedAt: new Date().toISOString(),
      allSucceeded: !failedCollection,
      counts,
    });
  } catch (err) {
    console.error('Failed to write backup manifest:', err);
    captureError(err, { source: 'dailyBackup', collection: '_manifest' });
  }
}

let intervalHandle = null;

export function startBackupJob() {
  if (intervalHandle) return;
  runBackup(); // take one immediately on boot rather than waiting a full day
  intervalHandle = setInterval(runBackup, CHECK_INTERVAL_MS);
}
