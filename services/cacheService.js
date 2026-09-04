const { kv } = require('@vercel/kv');
const { Redis } = require('@upstash/redis');
const logger = require('./logger');

let upstash = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    upstash = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    logger.info('Upstash Redis initialized as secondary cache');
  } catch (err) {
    logger.warn({ err }, 'Upstash Redis initialization failed');
  }
}

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
  let value = null;

  try {
    const kvValue = await kv.get(key);
    if (kvValue !== null && kvValue !== undefined) {
      value = safeParse(kvValue);
      if (value !== null) {
        logger.debug({ key, source: 'vercel-kv' }, 'Cache hit');
        return value;
      }
    }
  } catch (err) {
    logger.warn({ err, key, source: 'vercel-kv' }, 'Cache get failed');
  }

  if (upstash) {
    try {
      const upstashValue = await upstash.get(key);
      if (upstashValue !== null && upstashValue !== undefined) {
        value = safeParse(upstashValue);
        if (value !== null) {
          logger.debug({ key, source: 'upstash' }, 'Cache hit');
          return value;
        }
      }
    } catch (err) {
      logger.warn({ err, key, source: 'upstash' }, 'Cache get failed');
    }
  }

  if (memoryCache.has(key)) {
    const entry = memoryCache.get(key);
    if (entry.expiry > Date.now()) {
      logger.debug({ key, source: 'memory' }, 'Cache hit');
      return entry.value;
    }
    memoryCache.delete(key);
  }

  return null;
}

async function setCache(key, data, ttlSeconds = 3600) {
  const serialized = JSON.stringify(data);

  try {
    await kv.set(key, serialized, { ex: ttlSeconds });
    logger.debug({ key, ttlSeconds, source: 'vercel-kv' }, 'Cache set');
  } catch (err) {
    logger.warn({ err, key, source: 'vercel-kv' }, 'Cache set failed');
  }

  if (upstash) {
    try {
      await upstash.set(key, serialized, { ex: ttlSeconds });
      logger.debug({ key, ttlSeconds, source: 'upstash' }, 'Cache set');
    } catch (err) {
      logger.warn({ err, key, source: 'upstash' }, 'Cache set failed');
    }
  }

  try {
    memoryCache.set(key, { value: data, expiry: Date.now() + (ttlSeconds * 1000) });
    logger.debug({ key, ttlSeconds, source: 'memory' }, 'Cache set');
  } catch (err) {
    logger.warn({ err, key, source: 'memory' }, 'Cache set failed');
  }
}

async function deleteCache(key) {
  try {
    await kv.del(key);
    logger.debug({ key, source: 'vercel-kv' }, 'Cache delete');
  } catch (err) {
    logger.warn({ err, key, source: 'vercel-kv' }, 'Cache delete failed');
  }

  if (upstash) {
    try {
      await upstash.del(key);
      logger.debug({ key, source: 'upstash' }, 'Cache delete');
    } catch (err) {
      logger.warn({ err, key, source: 'upstash' }, 'Cache delete failed');
    }
  }

  memoryCache.delete(key);
  logger.debug({ key, source: 'memory' }, 'Cache delete');
}

async function clearAllCache() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('flushdb is disabled in production');
  }

  try {
    await kv.flushdb();
    logger.info('KV flushdb completed');
  } catch (err) {
    logger.warn({ err }, 'KV flushdb failed');
  }

  if (upstash) {
    try {
      await upstash.flushdb();
      logger.info('Upstash flushdb completed');
    } catch (err) {
      logger.warn({ err }, 'Upstash flushdb failed');
    }
  }

  memoryCache.clear();
  logger.info('Memory cache cleared');
}

module.exports = { getCache, setCache, deleteCache, clearAllCache };
