const logger = require('./logger');
const { getCache, setCache } = require('./cacheService');

const MAL_API = 'https://api.myanimelist.net/v2';
const USER_AGENT = 'KITO/1.0';
const SEARCH_TTL_SECONDS = 21600;
const CACHE_FETCH_LIMIT = 10;

const MIN_GAP_MS = 350;
const MINUTE_WINDOW_MS = 60000;
const MINUTE_MAX = 50;

const SEARCH_FIELDS = 'id,title,main_picture,alternative_titles,start_date,end_date,mean,media_type,status,num_episodes,popularity';
const DETAIL_FIELDS = 'id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,media_type,status,num_episodes,popularity,genres,studios,relations';

const FORBIDDEN_RELATION_TYPES = new Set([
  'sequel',
  'side_story',
  'spin_off',
  'summary'
]);

const VALID_MEDIA_TYPES = new Set(['tv', 'ona', 'ova', 'tv_special', 'special', 'movie']);

const requestQueue = [];
let isProcessing = false;

const requestTimestamps = [];

const inFlight = new Map();

function getClientId() {
  const id = process.env.MAL_CLIENT_ID;
  if (!id) throw new Error('MAL_CLIENT_ID is not set');
  return id;
}

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
    headers: {
      'User-Agent': USER_AGENT,
      'X-MAL-CLIENT-ID': getClientId()
    },
    signal: AbortSignal.timeout(8000)
  });
  if (res.status === 429) {
    logger.warn({ url }, 'MAL returned HTTP 429 (rate limit exceeded)');
    throw new Error('MAL HTTP 429');
  }
  if (!res.ok) {
    throw new Error(`MAL HTTP ${res.status}`);
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

function fetchMal(url) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    processQueue();
  });
}

async function fetchAndCacheMalSearch(query, cacheKey) {
  const url = `${MAL_API}/anime?q=${encodeURIComponent(query)}&limit=${CACHE_FETCH_LIMIT}&fields=${SEARCH_FIELDS}`;
  const response = await fetchMal(url);

  const rows = response?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    await setCache(cacheKey, [], SEARCH_TTL_SECONDS);
    return [];
  }

  const items = rows.map(r => r.node).filter(Boolean);

  const candidates = items.filter(item =>
    item.media_type && VALID_MEDIA_TYPES.has(item.media_type)
  );
  if (candidates.length === 0) {
    await setCache(cacheKey, [], SEARCH_TTL_SECONDS);
    return [];
  }

  const results = candidates.slice(0, CACHE_FETCH_LIMIT);
  await setCache(cacheKey, results, SEARCH_TTL_SECONDS);
  return results;
}

async function searchMal(query, limit = 5) {
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = `mal_search:v2:${normalizedQuery}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached.slice(0, limit);

  if (inFlight.has(cacheKey)) {
    const pending = await inFlight.get(cacheKey);
    return pending.slice(0, limit);
  }

  const promise = fetchAndCacheMalSearch(query, cacheKey);
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
  if (lower === 'finished_airing') return 'FINISHED';
  if (lower === 'currently_airing') return 'RELEASING';
  if (lower === 'not_yet_aired') return 'NOT_YET_RELEASED';
  if (lower === 'on_hiatus') return 'HIATUS';
  return rawStatus;
}

function extractYear(item) {
  const startDate = item.start_date;
  if (typeof startDate === 'string' && startDate.length >= 4) {
    const parsed = parseInt(startDate.slice(0, 4));
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

function collectAliases(item) {
  const list = [];
  const alt = item.alternative_titles || {};
  if (typeof alt.en === 'string') list.push(alt.en);
  if (typeof item.title === 'string') list.push(item.title);
  if (typeof alt.ja === 'string') list.push(alt.ja);
  if (Array.isArray(alt.synonyms)) list.push(...alt.synonyms);
  return [...new Set(list.filter(s => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()))];
}

function pickTitle(item) {
  const alt = item.alternative_titles || {};
  if (typeof alt.en === 'string' && alt.en.trim().length > 0) return alt.en.trim();
  if (typeof item.title === 'string' && item.title.trim().length > 0) return item.title.trim();
  if (typeof alt.ja === 'string' && alt.ja.trim().length > 0) return alt.ja.trim();
  return 'Unknown';
}

function extractForbiddenTitles(item) {
  if (!item || !Array.isArray(item.relations)) return [];
  const titles = [];
  for (const rel of item.relations) {
    if (!rel || !FORBIDDEN_RELATION_TYPES.has(rel.relation_type)) continue;
    const node = rel.node;
    if (!node || typeof node.title !== 'string') continue;
    const trimmed = node.title.trim();
    if (trimmed.length > 0) titles.push(trimmed);
  }
  return [...new Set(titles)];
}

function normalizeMalMedia(item, category) {
  if (!item || !item.id) return null;

  const title = pickTitle(item);
  const aliases = collectAliases(item);
  const year = extractYear(item);
  const poster = item.main_picture?.large || item.main_picture?.medium || '';
  const episodeCount = item.num_episodes && item.num_episodes > 0 ? item.num_episodes : null;
  const status = mapStatus(item.status);
  const mediaType = item.media_type;

  if (!poster) {
    logger.warn(
      { malId: item.id, title: item.title, hasMainPicture: !!item.main_picture },
      'MAL result has no poster'
    );
  }

  return {
    id: `mal:${item.id}`,
    title,
    aliases,
    year,
    poster,
    mediaType: mediaType === 'movie' ? 'movie' : 'series',
    episodeCount,
    status,
    provider: 'mal',
    providerId: String(item.id),
    category,
    format: mediaType ? mediaType.toUpperCase() : 'UNKNOWN',
    countryOfOrigin: 'JP',
    popularity: item.mean || 0,
    seasonNumber: null,
    seasonEpisodeCount: episodeCount,
    totalEpisodeCount: episodeCount,
    forbiddenTitles: extractForbiddenTitles(item)
  };
}

async function fetchMalDetail(id) {
  const url = `${MAL_API}/anime/${id}?fields=${DETAIL_FIELDS}`;
  return await fetchMal(url);
}

module.exports = { searchMal, normalizeMalMedia, fetchMal, fetchMalDetail };
