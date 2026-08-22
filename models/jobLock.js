import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// Lets multiple server instances (auto-scaling, or someone forgetting
// DISABLE_TELEGRAM_POLLING on a second local run) share one reminder job
// safely — see the acquireLock helper in jobs/reminders.js.
const JobLockSchema = new Schema({
  _id: { type: String, required: true },
  lockedUntil: { type: Date, required: true },
});

const JobLock = model('JobLock', JobLockSchema, 'JobLocks');

export default JobLock;
