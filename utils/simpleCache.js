import memoryCache from './cache.js';

export function getCached(key) {
  const val = memoryCache.get(key);
  return val === null ? undefined : val;
}

export function setCached(key, value, ttlMs) {
  const ttlSeconds = Math.max(1, Math.round((ttlMs || 60000) / 1000));
  memoryCache.set(key, value, ttlSeconds);
}

export function delCached(key) {
  memoryCache.del(key);
}

export function delCachedPrefix(prefix) {
  memoryCache.delPrefix(prefix);
}

export function invalidateShopCache(shopId) {
  if (shopId) {
    memoryCache.del(`shop:${shopId}`);
  }
  memoryCache.del('all-shops');
  memoryCache.del('home-feed');
  memoryCache.delPrefix('discovery:');
}

export { memoryCache };
