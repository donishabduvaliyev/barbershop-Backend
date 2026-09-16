// Shared in-memory MongoDB setup for integration tests — a real mongod
// (not a mock), so tests exercise the exact behavior that actually matters
// here: unique-index conflict handling, atomic findOneAndUpdate races, and
// Mongoose validation, none of which a stub of the driver would catch.
// Each test file gets its own isolated in-memory instance, wiped clean at
// the end of every test — no shared state between test files, and never
// touches the real production database.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod;

export async function setupTestDb() {
  process.env.TZ = 'Asia/Tashkent';
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

export async function teardownTestDb() {
  await mongoose.disconnect();
  await mongod.stop();
}

export async function clearTestDb() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}
