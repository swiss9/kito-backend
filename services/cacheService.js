const { kv } = require('@vercel/kv');
const logger = require('./logger');

const memoryCache = new Map();

function safeParse(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  return value;
}

async function getCache(key) {
  try {
    const kvValue = await kv.get(key);
    if (kvValue !== null && kvValue !== undefined) {
      const parsed = safeParse(kvValue);
      if (parsed !== null) {
        return parsed;
      }
    }
    if (memoryCache.has(key)) {
      const entry = memoryCache.get(key);
      if (entry.expiry > Date.now()) {
        return entry.value;
      }
      memoryCache.delete(key);
    }
    return null;
  } catch (err) {
    logger.warn({ err, key }, 'KV get failed, falling back to memory');
    if (memoryCache.has(key)) {
      const entry = memoryCache.get(key);
      if (entry.expiry > Date.now()) {
        return entry.value;
      }
      memoryCache.delete(key);
    }
    return null;
  }
}

async function setCache(key, data, ttlSeconds = 3600) {
  try {
    const serialized = JSON.stringify(data);
    await kv.set(key, serialized, { ex: ttlSeconds });
    memoryCache.set(key, { value: data, expiry: Date.now() + (ttlSeconds * 1000) });
  } catch (err) {
    logger.warn({ err, key }, 'KV set failed, falling back to memory');
    memoryCache.set(key, { value: data, expiry: Date.now() + (ttlSeconds * 1000) });
  }
}

async function deleteCache(key) {
  try {
    await kv.del(key);
    memoryCache.delete(key);
  } catch (err) {
    logger.warn({ err, key }, 'KV delete failed, deleting from memory only');
    memoryCache.delete(key);
  }
}

async function clearAllCache() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('flushdb is disabled in production');
  }
  try {
    await kv.flushdb();
    memoryCache.clear();
  } catch (err) {
    logger.warn({ err }, 'KV flush failed, clearing memory only');
    memoryCache.clear();
  }
}

module.exports = { getCache, setCache, deleteCache, clearAllCache };
