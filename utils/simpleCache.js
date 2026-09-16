// A minimal in-process TTL cache — not Redis, deliberately: this app runs
// as a single Node instance (see server.js), so a plain in-memory Map
// costs nothing extra to deploy and is invisible to correctness (a stale
// read for a few seconds on a browse-only endpoint is imperceptible, and
// nothing here is ever used for a write path or anything security-sensitive).
//
// Exists to absorb the highest-traffic, identical-for-everyone reads
// (the default home feed and search-page browse view) so a burst of
// concurrent page loads costs one real database round-trip instead of one
// per visitor — see routes/shops.js's home-feed and discovery-search.
const store = new Map();

export function getCached(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCached(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}
