/**
 * In-Memory TTL Cache Utility
 * Designed for resource-constrained environments (e.g. Render Free Tier 512MB RAM).
 * Provides lightning-fast in-memory caching for read-heavy MongoDB queries with
 * zero external dependencies, bounded memory footprint, and tag/prefix invalidation.
 */

export class MemoryCache {
  constructor(maxSize = 1000) {
    this.store = new Map();
    this.maxSize = maxSize;

    // Periodic sweep every 60s to prevent stale memory buildup
    if (typeof setInterval !== 'undefined') {
      const interval = setInterval(() => this.sweep(), 60000);
      if (interval.unref) interval.unref();
    }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key, value, ttlSeconds = 60) {
    // If cache reaches max capacity, evict the oldest entry
    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  del(key) {
    this.store.delete(key);
  }

  delPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }
}

export const memoryCache = new MemoryCache(1000);
export default memoryCache;
