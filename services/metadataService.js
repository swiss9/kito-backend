const { httpGet, httpPost } = require('./httpClient');
const logger = require('./logger');
const { getCache, setCache } = require('./cacheService');
const { searchShikimori, normalizeShikimoriMedia } = require('./shikimoriService');

const KITSU_API = 'https://kitsu.io/api/edge';
const JIKAN_API = 'https://api.jikan.moe/v4';

const jikanQueue = [];
let jikanProcessing = false;
let jikanLastRequest = 0;
const JIKAN_MIN_INTERVAL = 350;

async function processJikanQueue() {
  if (jikanProcessing || jikanQueue.length === 0) return;
  jikanProcessing = true;

  while (jikanQueue.length > 0) {
    const now = Date.now();
    const elapsed = now - jikanLastRequest;
    if (elapsed < JIKAN_MIN_INTERVAL) {
      await new Promise(r => setTimeout(r, JIKAN_MIN_INTERVAL - elapsed));
    }
    const { url, resolve, reject } = jikanQueue.shift();
    jikanLastRequest = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'KITO/1.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) {
        reject(new Error(`Jikan HTTP ${res.status}`));
      } else {
        resolve(await res.json());
      }
    } catch (err) {
      reject(err);
    }
  }

  jikanProcessing = false;
  if (jikanQueue.length > 0) processJikanQueue();
}

function fetchJikanQueued(url) {
  return new Promise((resolve, reject) => {
    jikanQueue.push({ url, resolve, reject });
    processJikanQueue();
  });
}

async function searchJikan(title) {
  const cacheKey = `jikan_search:${title.toLowerCase().trim()}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const searchUrl = `${JIKAN_API}/anime?q=${encodeURIComponent(title)}&limit=10`;
    const res = await fetchJikanQueued(searchUrl);
    if (!res.data || res.data.length === 0) return [];

    const candidates = res.data.filter(item =>
      ['TV', 'Movie', 'OVA', 'ONA', 'Special'].includes(item.type)
    );
    if (candidates.length === 0) return [];

    const sorted = candidates.sort((a, b) => {
      const aScore = (a.episodes || 0) * 10 + (a.score || 0);
      const bScore = (b.episodes || 0) * 10 + (b.score || 0);
      return bScore - aScore;
    });

    const best = sorted[0];
    const detailUrl = `${JIKAN_API}/anime/${best.mal_id}`;
    const detailRes = await fetchJikanQueued(detailUrl);
    const normalized = normalizeJikanMedia(detailRes.data, 'anime');

    await setCache(cacheKey, normalized ? [normalized] : [], 43200);
    return normalized ? [normalized] : [];
  } catch (err) {
    logger.warn({ err, title }, 'Jikan search failed');
    return [];
  }
}

async function searchKitsu(query) {
  const cacheKey = `kitsu_search:${query.toLowerCase().trim()}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `${KITSU_API}/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=10`;
    const res = await httpGet(url, {
      headers: { 'Accept': 'application/vnd.api+json' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.data || [];
    if (items.length === 0) return [];

    const candidates = items.filter(item =>
      item.attributes?.showType && ['TV', 'movie', 'OVA', 'ONA', 'special'].includes(item.attributes.showType)
    );
    if (candidates.length === 0) return [];

    const sorted = candidates.sort((a, b) => {
      const aScore = (a.attributes?.episodeCount || 0) * 10 + (a.attributes?.averageRating ? parseFloat(a.attributes.averageRating) : 0);
      const bScore = (b.attributes?.episodeCount || 0) * 10 + (b.attributes?.averageRating ? parseFloat(b.attributes.averageRating) : 0);
      return bScore - aScore;
    });

    const best = sorted[0];
    const detailUrl = `${KITSU_API}/anime/${best.id}`;
    const detailRes = await httpGet(detailUrl, {
      headers: { 'Accept': 'application/vnd.api+json' }
    });
    const detailData = await detailRes.json();
    const normalized = normalizeKitsuMedia(detailData.data);

    await setCache(cacheKey, normalized ? [normalized] : [], 43200);
    return normalized ? [normalized] : [];
  } catch (err) {
    logger.warn({ err, query }, 'Kitsu search failed');
    return [];
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
  const genres = (attrs.categories || []).map(c => c.title || c.name) || [];
  const popularity = attrs.popularityRank || 0;
  const aliases = [titles.en_jp, titles.ja_jp, ...(attrs.abbreviatedTitles || [])].filter(Boolean);
  const isAdult = attrs.ageRating === 'R18' || attrs.ageRating === 'R18+' || false;

  return {
    id: `kitsu:${item.id}`,
    title,
    aliases,
    year,
    poster,
    mediaType: attrs.showType === 'movie' ? 'movie' : 'series',
    episodeCount,
    genres,
    status,
    isAdult,
    popularity,
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

function normalizeJikanMedia(item, category) {
  if (!item) return null;
  return {
    id: `jikan:${item.mal_id}`,
    title: item.title || 'Unknown',
    aliases: [item.title_english, item.title_japanese, ...(item.titles || []).map(t => t.title)].filter(Boolean),
    year: item.year || (item.aired?.prop?.from?.year) || null,
    poster: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || '',
    mediaType: item.type === 'Movie' ? 'movie' : 'series',
    episodeCount: item.episodes || null,
    genres: (item.genres || []).map(g => g.name),
    status: item.status || 'UNKNOWN',
    isAdult: item.rating === 'Rx - Hentai' || false,
    provider: 'jikan',
    providerId: String(item.mal_id),
    category,
    seasonNumber: null,
    seasonEpisodeCount: item.episodes || null,
    totalEpisodeCount: item.episodes || null
  };
}

function normalizeAniListMedia(item, category, relations = []) {
  if (!item) return null;
  return {
    id: `anilist:${item.id}`,
    title: item.title?.romaji || item.title?.english || item.title?.native || 'Unknown',
    aliases: [...(item.synonyms || []), item.title?.english, item.title?.native].filter(Boolean),
    year: item.seasonYear,
    poster: item.coverImage?.medium || item.coverImage?.large || '',
    mediaType: item.format === 'MOVIE' ? 'movie' : 'series',
    episodeCount: item.episodes || item.chapters || null,
    genres: item.genres || [],
    status: item.status || 'UNKNOWN',
    isAdult: item.isAdult || false,
    format: item.format,
    provider: 'anilist',
    providerId: String(item.id),
    category,
    relations,
    countryOfOrigin: item.countryOfOrigin || 'JP',
    popularity: item.popularity || 0,
    seasonNumber: null,
    seasonEpisodeCount: item.episodes || null,
    totalEpisodeCount: item.episodes || null
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
    genres: (item.genres || []).map(g => g.name),
    status: item.status || 'UNKNOWN',
    isAdult: item.adult || false,
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
    subtitle: `${media.year || 'N/A'} Â· ${episodes} Â· ${(media.genres || []).slice(0, 3).join(', ')}`,
    category: media.category,
    poster: media.poster,
    provider: media.provider,
    providerId: media.providerId,
    year: media.year,
    episodeCount: media.episodeCount,
    genres: media.genres,
    aliases: media.aliases,
    mediaType: media.mediaType,
    status: media.status,
    isAdult: media.isAdult,
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

  const res = await httpGet(url.toString());
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  const data = await res.json();
  const result = data.results || data;
  await setCache(cacheKey, result, 3600);
  return result;
}

async function fetchAniList(query, variables) {
  const { fetchAniListWithProxy } = require('./anilistProxy');
  try {
    const data = await fetchAniListWithProxy(query, variables);
    return data.data;
  } catch (err) {
    logger.warn({ err, query: query.slice(0, 100) }, 'AniList request failed via proxy');
    throw err;
  }
}

async function searchAnilistByTitle(title) {
  const query = `
    query($search: String) {
      Media(search: $search, type: ANIME) {
        id
        title { romaji english native }
        synonyms
        seasonYear
        coverImage { medium large }
        format
        episodes
        status
        genres
        isAdult
        popularity
      }
    }
  `;
  try {
    const data = await fetchAniList(query, { search: title });
    return data.Media || null;
  } catch (err) {
    logger.warn({ err, title }, 'AniList search by title failed');
    return null;
  }
}

module.exports = {
  fetchAniList,
  searchAnilistByTitle,
  fetchTmdb,
  searchKitsu,
  searchJikan,
  searchShikimori,
  normalizeKitsuMedia,
  normalizeAniListMedia,
  normalizeJikanMedia,
  normalizeTmdbMedia,
  normalizeShikimoriMedia,
  mediaToCard
};
