const { httpGet, httpPost } = require('./httpClient');
const logger = require('./logger');
const { getCache, setCache } = require('./cacheService');

const ANILIST_API = 'https://graphql.anilist.co';
const KITSU_API = 'https://kitsu.io/api/edge';

async function fetchAniList(query, variables) {
  try {
    const data = await httpPost(ANILIST_API, { query, variables });
    if (data.errors) {
      throw new Error(data.errors[0].message);
    }
    return data.data;
  } catch (err) {
    logger.warn({ err, query: query.slice(0, 100) }, 'AniList request failed');
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

async function fetchTmdb(endpoint, params = {}) {
  const baseUrl = 'https://api.themoviedb.org/3';
  const url = new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set('api_key', process.env.TMDB_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  const data = await res.json();
  return data.results || data;
}

async function searchKitsu(query) {
  const cacheKey = `kitsu_search:${query.toLowerCase().trim()}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `${KITSU_API}/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=20`;
    const res = await fetch(url, { headers: { 'Accept': 'application/vnd.api+json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.data || [];
    const normalized = items.map(item => normalizeKitsuMedia(item)).filter(Boolean);
    await setCache(cacheKey, normalized, 43200);
    return normalized;
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
    relations: []
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
  };
}

function normalizeJikanMedia(item, category) {
  if (!item) return null;
  return {
    id: `jikan:${item.mal_id}`,
    title: item.title || 'Unknown',
    aliases: [item.title_english, item.title_japanese, ...(item.titles || []).map(t => t.title)].filter(Boolean),
    year: item.year || item.seasonYear || null,
    poster: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || '',
    mediaType: item.type === 'Movie' ? 'movie' : 'series',
    episodeCount: item.episodes || null,
    genres: (item.genres || []).map(g => g.name),
    status: item.status || 'UNKNOWN',
    isAdult: item.isAdult || false,
    provider: 'jikan',
    providerId: String(item.mal_id),
    category,
  };
}

function normalizeTmdbMedia(item, category) {
  if (!item) return null;
  const title = item.title || item.name || 'Unknown';
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  return {
    id: `tmdb:${item.id}`,
    title,
    aliases: [item.original_title, item.original_name, ...(item.alternative_titles?.titles || []).map(t => t.title)].filter(Boolean),
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
  };
}

function mediaToCard(media) {
  if (!media) return null;
  return {
    id: media.id,
    title: media.title,
    subtitle: `${media.year || 'N/A'} Â· ${media.episodeCount || '?'} eps Â· ${(media.genres || []).slice(0, 3).join(', ')}`,
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
  };
}

module.exports = {
  fetchAniList,
  searchAnilistByTitle,
  fetchTmdb,
  searchKitsu,
  normalizeKitsuMedia,
  normalizeAniListMedia,
  normalizeJikanMedia,
  normalizeTmdbMedia,
  mediaToCard,
};
