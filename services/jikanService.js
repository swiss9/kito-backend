const logger = require('./logger');
const { getCache, setCache } = require('./cacheService');

const JIKAN_API = 'https://api.jikan.moe/v4';
const USER_AGENT = 'KITO/1.0';
const SEARCH_TTL_SECONDS = 21600;
const CACHE_FETCH_LIMIT = 10;

const MIN_GAP_MS = 350;
const MINUTE_WINDOW_MS = 60000;
const MINUTE_MAX = 50;

const requestQueue = [];
let isProcessing = false;

const requestTimestamps = [];

const inFlight = new Map();

async function waitForSlot() {
  while (true) {
    const now = Date.now();

    while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= MINUTE_WINDOW_MS) {
      requestTimestamps.shift();
    }

    if (requestTimestamps.length >= MINUTE_MAX) {
      const waitMs = MINUTE_WINDOW_MS - (now - requestTimestamps[0]) + 5;
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    const last = requestTimestamps.length > 0 ? requestTimestamps[requestTimestamps.length - 1] : 0;
    const elapsed = now - last;
    if (elapsed < MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, MIN_GAP_MS - elapsed));
      continue;
    }

    requestTimestamps.push(Date.now());
    return;
  }
}

async function executeRequest(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000)
  });
  if (res.status === 429) {
    logger.warn({ url }, 'Jikan returned HTTP 429 (rate limit exceeded)');
    throw new Error('Jikan HTTP 429');
  }
  if (!res.ok) {
    throw new Error(`Jikan HTTP ${res.status}`);
  }
  return res.json();
}

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  const inFlightPromises = [];

  while (requestQueue.length > 0) {
    await waitForSlot();
    const { url, resolve, reject } = requestQueue.shift();
    const promise = executeRequest(url).then(resolve).catch(reject);
    inFlightPromises.push(promise);
  }

  await Promise.all(inFlightPromises);

  isProcessing = false;
  if (requestQueue.length > 0) processQueue();
}

function fetchJikan(url) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    processQueue();
  });
}

const KIND_PRIORITY = {
  TV: 100,
  ONA: 60,
  OVA: 50,
  Special: 40,
  Movie: 30
};

async function fetchAndCacheJikanSearch(query, cacheKey) {
  const url = `${JIKAN_API}/anime?q=${encodeURIComponent(query)}&limit=${CACHE_FETCH_LIMIT}&sfw=true`;
  const response = await fetchJikan(url);

  const data = response?.data;
  if (!Array.isArray(data) || data.length === 0) {
    await setCache(cacheKey, [], SEARCH_TTL_SECONDS);
    return [];
  }

  const candidates = data.filter(item =>
    item.type && Object.prototype.hasOwnProperty.call(KIND_PRIORITY, item.type)
  );
  if (candidates.length === 0) {
    await setCache(cacheKey, [], SEARCH_TTL_SECONDS);
    return [];
  }

  const sorted = candidates.sort((a, b) => {
    const aP = KIND_PRIORITY[a.type] || 0;
    const bP = KIND_PRIORITY[b.type] || 0;
    if (aP !== bP) return bP - aP;
    return (b.score || 0) - (a.score || 0);
  });

  const results = sorted.slice(0, CACHE_FETCH_LIMIT);
  await setCache(cacheKey, results, SEARCH_TTL_SECONDS);
  return results;
}

async function searchJikan(query, limit = 5) {
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = `jikan_search:v1:${normalizedQuery}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached.slice(0, limit);

  if (inFlight.has(cacheKey)) {
    const pending = await inFlight.get(cacheKey);
    return pending.slice(0, limit);
  }

  const promise = fetchAndCacheJikanSearch(query, cacheKey);
  inFlight.set(cacheKey, promise);

  try {
    const result = await promise;
    return result.slice(0, limit);
  } finally {
    inFlight.delete(cacheKey);
  }
}

function mapStatus(rawStatus) {
  if (!rawStatus || typeof rawStatus !== 'string') return 'UNKNOWN';
  const lower = rawStatus.toLowerCase();
  if (lower.includes('finished')) return 'FINISHED';
  if (lower.includes('currently')) return 'RELEASING';
  if (lower.includes('not yet')) return 'NOT_YET_RELEASED';
  if (lower.includes('hiatus')) return 'HIATUS';
  return rawStatus;
}

function extractYear(item) {
  if (item.year) return item.year;
  const from = item.aired?.from;
  if (typeof from === 'string' && from.length >= 4) {
    const parsed = parseInt(from.slice(0, 4));
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

function pickEnglishTitle(item) {
  if (typeof item.title_english === 'string' && item.title_english.trim().length > 0) {
    return item.title_english.trim();
  }
  if (Array.isArray(item.titles)) {
    for (const entry of item.titles) {
      if (!entry) continue;
      if (entry.type === 'English' && typeof entry.title === 'string' && entry.title.trim().length > 0) {
        return entry.title.trim();
      }
    }
  }
  return null;
}

function collectAliases(item) {
  const list = [];
  if (typeof item.title_english === 'string') list.push(item.title_english);
  if (typeof item.title === 'string') list.push(item.title);
  if (typeof item.title_japanese === 'string') list.push(item.title_japanese);
  if (Array.isArray(item.title_synonyms)) list.push(...item.title_synonyms);
  if (Array.isArray(item.synonyms)) list.push(...item.synonyms);
  if (Array.isArray(item.titles)) {
    for (const t of item.titles) {
      if (t && typeof t.title === 'string') list.push(t.title);
    }
  }
  return [...new Set(list.filter(s => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()))];
}

function normalizeJikanMedia(item, category) {
  if (!item || !item.mal_id) return null;

  const title = pickEnglishTitle(item) || item.title || item.title_japanese || 'Unknown';
  const aliases = collectAliases(item);
  const year = extractYear(item);
  const poster = item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || '';
  const episodeCount = item.episodes || null;
  const status = mapStatus(item.status);

  return {
    id: `jikan:${item.mal_id}`,
    title,
    aliases,
    year,
    poster,
    mediaType: item.type === 'Movie' ? 'movie' : 'series',
    episodeCount,
    status,
    provider: 'jikan',
    providerId: String(item.mal_id),
    category,
    format: item.type ? item.type.toUpperCase() : 'UNKNOWN',
    countryOfOrigin: 'JP',
    popularity: item.score || 0,
    seasonNumber: null,
    seasonEpisodeCount: episodeCount,
    totalEpisodeCount: episodeCount
  };
}

module.exports = { searchJikan, normalizeJikanMedia, fetchJikan };
