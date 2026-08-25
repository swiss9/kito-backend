const { kv } = require('@vercel/kv');

const memoryCache = new Map();
const cacheTimers = new Map();

async function getCache(key) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const value = await kv.get(key);
      return value ? (typeof value === 'string' ? JSON.parse(value) : value) : null;
    } catch (err) {
      console.warn('Vercel KV get failed, falling back to memory:', err.message);
    }
  }
  return memoryCache.get(key) || null;
}

async function setCache(key, data, ttlSeconds = 3600) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      await kv.set(key, JSON.stringify(data), { ex: ttlSeconds });
      return;
    } catch (err) {
      console.warn('Vercel KV set failed, using memory cache:', err.message);
    }
  }

  if (cacheTimers.has(key)) {
    clearTimeout(cacheTimers.get(key));
    cacheTimers.delete(key);
  }

  memoryCache.set(key, data);

  const timer = setTimeout(() => {
    memoryCache.delete(key);
    cacheTimers.delete(key);
  }, ttlSeconds * 1000);

  cacheTimers.set(key, timer);
}

module.exports = { getCache, setCache };
