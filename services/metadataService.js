const { httpGet } = require('./httpClient');
const logger = require('./logger');
const { getCache, setCache } = require('./cacheService');
const { searchShikimori, normalizeShikimoriMedia, fetchShikimori } = require('./shikimoriService');

const KITSU_API = 'https://kitsu.io/api/edge';
const KITSU_TTL_SECONDS = 21600;
const TMDB_TTL_SECONDS = 86400;
const CACHE_FETCH_LIMIT = 10;

const kitsuInFlight = new Map();

async function fetchAndCacheKitsuSearch(query, cacheKey) {
  const url = `${KITSU_API}/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=${CACHE_FETCH_LIMIT}`;
  const res = await httpGet(url, {
    headers: { 'Accept': 'application/vnd.api+json' },
    timeoutMs: 4000,
    maxRetries: 0
  });

  if (!res.ok) {
    throw new Error(`Kitsu HTTP ${res.status}`);
  }

  const data = await res.json();
  const items = data.data || [];

  if (items.length === 0) {
    await setCache(cacheKey, [], KITSU_TTL_SECONDS);
    return [];
  }

  const candidates = items.filter(item =>
    item.attributes?.showType && ['TV', 'movie', 'OVA', 'ONA', 'special'].includes(item.attributes.showType)
  );
  if (candidates.length === 0) {
    await setCache(cacheKey, [], KITSU_TTL_SECONDS);
    return [];
  }

  const sorted = candidates.sort((a, b) => {
    const aScore = (a.attributes?.episodeCount || 0) * 10 + (a.attributes?.averageRating ? parseFloat(a.attributes.averageRating) : 0);
    const bScore = (b.attributes?.episodeCount || 0) * 10 + (b.attributes?.averageRating ? parseFloat(b.attributes.averageRating) : 0);
    return bScore - aScore;
  });

  const normalized = sorted
    .slice(0, CACHE_FETCH_LIMIT)
    .map(item => normalizeKitsuMedia(item))
    .filter(Boolean);

  await setCache(cacheKey, normalized, KITSU_TTL_SECONDS);
  return normalized;
}

async function searchKitsu(query, limit = 5) {
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = `kitsu_search:${normalizedQuery}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached.slice(0, limit);

  if (kitsuInFlight.has(cacheKey)) {
    const pending = await kitsuInFlight.get(cacheKey);
    return pending.slice(0, limit);
  }

  const promise = fetchAndCacheKitsuSearch(query, cacheKey);
  kitsuInFlight.set(cacheKey, promise);

  try {
    const result = await promise;
    return result.slice(0, limit);
  } finally {
    kitsuInFlight.delete(cacheKey);
  }
}

function normalizeKitsuMedia(item) {
  if (!item || !item.id) return null;
  const attrs = item.attributes || {};
  const titles = attrs.titles || {};
  const title = attrs.canonicalTitle || titles.en || titles.en_jp || titles.ja_jp || 'Unknown';
  const poster = attrs.posterImage?.original || attrs.posterImage?.large || '';
  const year = attrs.startDate ? parseInt(attrs.startDate.slice(0, 4)) : null;
  const episodeCount = attrs.episodeCount || null;
  const status = attrs.status || 'UNKNOWN';
  const popularity = attrs.popularityRank || 0;
  const aliases = [titles.en_jp, titles.ja_jp, ...(attrs.abbreviatedTitles || [])].filter(Boolean);

  return {
    id: `kitsu:${item.id}`,
    title,
    aliases,
    year,
    poster,
    mediaType: attrs.showType === 'movie' ? 'movie' : 'series',
    episodeCount,
    status,
    provider: 'kitsu',
    providerId: String(item.id),
    category: 'anime',
    format: attrs.showType || 'UNKNOWN',
    relations: [],
    seasonNumber: null,
    seasonEpisodeCount: episodeCount,
    totalEpisodeCount: episodeCount
  };
}

function normalizeTmdbMedia(item, category) {
  if (!item) return null;
  const title = item.title || item.name || 'Unknown';
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  return {
    id: `tmdb:${item.id}`,
    title,
    aliases: [item.original_title, item.original_name].filter(Boolean),
    year: item.release_date?.slice(0, 4) || item.first_air_date?.slice(0, 4) || null,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
    mediaType: mediaType === 'movie' ? 'movie' : 'series',
    episodeCount: item.number_of_episodes || null,
    status: item.status || 'UNKNOWN',
    provider: 'tmdb',
    providerId: String(item.id),
    category,
    origin_country: item.origin_country?.[0] || 'JP',
    popularity: item.popularity || 0,
    seasonNumber: null,
    seasonEpisodeCount: item.number_of_episodes || null,
    totalEpisodeCount: item.number_of_episodes || null
  };
}

function mediaToCard(media) {
  if (!media) return null;
  const episodes = media.episodeCount ? `${media.episodeCount} eps` : '? eps';
  return {
    id: media.id,
    title: media.title,
    subtitle: `${media.year || 'N/A'} Â· ${episodes}`,
    category: media.category,
    poster: media.poster,
    provider: media.provider,
    providerId: media.providerId,
    year: media.year,
    episodeCount: media.episodeCount,
    aliases: media.aliases,
    mediaType: media.mediaType,
    status: media.status,
    hasRelease: false,
    hasBatch: false,
    popularity: media.popularity || 0,
    countryOfOrigin: media.countryOfOrigin || media.origin_country || 'JP'
  };
}

async function fetchTmdb(endpoint, params = {}) {
  const baseUrl = 'https://api.themoviedb.org/3';
  const url = new URL(`${baseUrl}/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const cacheKey = `tmdb:${url.toString()}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  url.searchParams.set('api_key', process.env.TMDB_API_KEY);

  const res = await httpGet(url.toString(), {
    timeoutMs: 4000,
    maxRetries: 0
  });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  const data = await res.json();
  const result = data.results || data;
  await setCache(cacheKey, result, TMDB_TTL_SECONDS);
  return result;
}

module.exports = {
  fetchTmdb,
  searchKitsu,
  searchShikimori,
  fetchShikimori,
  normalizeKitsuMedia,
  normalizeTmdbMedia,
  normalizeShikimoriMedia,
  mediaToCard
};
