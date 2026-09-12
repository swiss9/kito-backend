const logger = require('./logger');

const SHIKIMORI_API = 'https://shikimori.one/api';
const USER_AGENT = 'KITO/1.0';

const requestQueue = [];
let isProcessing = false;
const MIN_INTERVAL_MS = 200;
let lastRequestTime = 0;

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

async function searchShikimori(query) {
  const url = `${SHIKIMORI_API}/animes?search=${encodeURIComponent(query)}&limit=10`;
  try {
    const data = await fetchShikimori(url);
    if (!Array.isArray(data) || data.length === 0) return [];

    const candidates = data.filter(item =>
      item.kind && ['tv', 'movie', 'ova', 'ona', 'special'].includes(item.kind)
    );

    const sorted = candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    const best = sorted[0];
    if (!best) return [];

    const detailUrl = `${SHIKIMORI_API}/animes/${best.id}`;
    const detail = await fetchShikimori(detailUrl);
    return [detail];
  } catch (err) {
    logger.warn({ err, query }, 'Shikimori search failed');
    return [];
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
  const englishValues = toAliasArray(item.english);
  const japaneseValues = toAliasArray(item.japanese);
  const aliases = [...new Set([...nameValues, ...englishValues, ...japaneseValues])];

  return {
    id: `shikimori:${item.id}`,
    title: nameValues[0] || englishValues[0] || japaneseValues[0] || 'Unknown',
    aliases,
    year,
    poster,
    mediaType: item.kind === 'movie' ? 'movie' : 'series',
    episodeCount: item.episodes || null,
    genres: (item.genres || []).map(g => g.russian || g.name),
    status: item.status || 'UNKNOWN',
    isAdult: item.rating === 'r_plus' || item.rating === 'rx',
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
