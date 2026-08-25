const { Redis } = require('@upstash/redis');

let redisClient = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redisClient = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

const memoryCache = new Map();

async function getCache(key) {
  if (redisClient) {
    try {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (err) {
      console.warn('Redis get failed, falling back to memory:', err.message);
    }
  }
  return memoryCache.get(key) || null;
}

async function setCache(key, data, ttlSeconds = 3600) {
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(data), { ex: ttlSeconds });
      return;
    } catch (err) {
      console.warn('Redis set failed, using memory cache:', err.message);
    }
  }
  memoryCache.set(key, data);
  setTimeout(() => memoryCache.delete(key), ttlSeconds * 1000);
}

module.exports = { getCache, setCache };
