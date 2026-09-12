const logger = require('./logger');
const { getCache, setCache } = require('./cacheService');

const SHIKIMORI_API = 'https://shikimori.one/api';
const USER_AGENT = 'KITO/1.0';
const SEARCH_TTL_SECONDS = 21600;
const CACHE_FETCH_LIMIT = 10;

const requestQueue = [];
let isProcessing = false;
const MIN_INTERVAL_MS = 200;
let lastRequestTime = 0;

const inFlight = new Map();

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
    }
    const { url, resolve, reject } = requestQueue.shift();
    lastRequestTime = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) {
        reject(new Error(`Shikimori HTTP ${res.status}`));
      } else {
        resolve(await res.json());
      }
    } catch (err) {
      reject(err);
    }
  }

  isProcessing = false;
  if (requestQueue.length > 0) processQueue();
}

function fetchShikimori(url) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    processQueue();
  });
}

const KIND_PRIORITY = {
  tv: 100,
  ona: 60,
  ova: 50,
  special: 40,
  movie: 30
};

async function fetchAndCacheShikimoriSearch(query, cacheKey) {
  const url = `${SHIKIMORI_API}/animes?search=${encodeURIComponent(query)}&limit=${CACHE_FETCH_LIMIT}`;
  const data = await fetchShikimori(url);

  if (!Array.isArray(data) || data.length === 0) {
    await setCache(cacheKey, [], SEARCH_TTL_SECONDS);
    return [];
  }

  const candidates = data.filter(item =>
    item.kind && Object.prototype.hasOwnProperty.call(KIND_PRIORITY, item.kind)
  );
  if (candidates.length === 0) {
    await setCache(cacheKey, [], SEARCH_TTL_SECONDS);
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  const exactMatches = candidates.filter(item => {
    const names = [item.name, item.russian]
      .filter(Boolean)
      .map(n => n.toLowerCase().trim());
    return names.includes(normalizedQuery);
  });

  const pool = exactMatches.length > 0 ? exactMatches : candidates;

  const sorted = pool.sort((a, b) => {
    const aP = KIND_PRIORITY[a.kind] || 0;
    const bP = KIND_PRIORITY[b.kind] || 0;
    if (aP !== bP) return bP - aP;
    return (b.score || 0) - (a.score || 0);
  });

  const results = sorted.slice(0, CACHE_FETCH_LIMIT);
  await setCache(cacheKey, results, SEARCH_TTL_SECONDS);
  return results;
}

async function searchShikimori(query, limit = 5) {
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = `shikimori_search:${normalizedQuery}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached.slice(0, limit);

  if (inFlight.has(cacheKey)) {
    const pending = await inFlight.get(cacheKey);
    return pending.slice(0, limit);
  }

  const promise = fetchAndCacheShikimoriSearch(query, cacheKey);
  inFlight.set(cacheKey, promise);

  try {
    const result = await promise;
    return result.slice(0, limit);
  } finally {
    inFlight.delete(cacheKey);
  }
}

function toAliasArray(value) {
  if (Array.isArray(value)) {
    return value.filter(v => typeof v === 'string' && v.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
}

function normalizeShikimoriMedia(item, category) {
  if (!item) return null;
  const year = item.aired_on ? parseInt(item.aired_on.slice(0, 4)) : null;
  const poster = item.image?.original
    ? `https://shikimori.one${item.image.original}`
    : item.image?.preview
      ? `https://shikimori.one${item.image.preview}`
      : '';

  const nameValues = toAliasArray(item.name);
  const russianValues = toAliasArray(item.russian);
  const aliases = [...new Set([...nameValues, ...russianValues])];

  return {
    id: `shikimori:${item.id}`,
    title: nameValues[0] || russianValues[0] || 'Unknown',
    aliases,
    year,
    poster,
    mediaType: item.kind === 'movie' ? 'movie' : 'series',
    episodeCount: item.episodes || null,
    status: item.status || 'UNKNOWN',
    provider: 'shikimori',
    providerId: String(item.id),
    category,
    format: item.kind?.toUpperCase() || 'UNKNOWN',
    countryOfOrigin: 'JP',
    popularity: item.score || 0,
    seasonNumber: null,
    seasonEpisodeCount: item.episodes || null,
    totalEpisodeCount: item.episodes || null
  };
}

module.exports = { searchShikimori, normalizeShikimoriMedia, fetchShikimori };
