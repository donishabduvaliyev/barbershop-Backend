import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests spin up a real in-memory MongoDB per file (see
    // tests/setupDb.js) — the first run downloads/caches a mongod binary,
    // and even a cached start takes longer than vitest's 5s default.
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
