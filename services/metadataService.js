const { TMDB_API_KEY } = require('../config');
const { normalizeTitle, extractReleaseTitle, escapeRegex } = require('../utils');
const { MediaType } = require('../config');

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w300';
const ANILIST_API = 'https://graphql.anilist.co';

function stripYearFromTitle(title) {
  if (!title) return '';
  return title.replace(/\s*\(\d{4}\)$/, '').trim();
}

async function fetchAniList(query, variables) {
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000)
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

async function searchAnilistByTitle(title) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 1) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          title { romaji english native }
          synonyms
          seasonYear
          coverImage { medium large }
          format
          episodes
          status
          genres
        }
      }
    }
  `;
  const data = await fetchAniList(query, { search: title });
  if (!data.Page || !data.Page.media || data.Page.media.length === 0) return null;
  return data.Page.media[0];
}

async function fetchTmdb(endpoint, params = {}) {
  if (!TMDB_API_KEY) return [];
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') url.searchParams.set(key, val);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function searchJikan(query) {
  const normalized = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(normalized)}&limit=50`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'KITO/1.0 (https://kito.app)' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

function normalizeAniListMedia(item, categoryId, relations = []) {
  const aliases = [
    item.title?.romaji,
    item.title?.english,
    item.title?.native,
    ...(item.synonyms || [])
  ].filter(Boolean);

  const baseTitle = item.title?.romaji || item.title?.english || '';
  const strippedTitle = stripYearFromTitle(baseTitle);
  if (strippedTitle && strippedTitle !== baseTitle) {
    aliases.push(strippedTitle);
  }

  let poster = item.coverImage?.large || item.coverImage?.medium || '';
  if (poster && poster.startsWith('http://')) poster = poster.replace('http://', 'https://');

  return {
    id: `anilist:${item.id}`,
    title: item.title?.romaji || item.title?.english || item.title?.native || 'Unknown',
    aliases,
    year: item.seasonYear || null,
    mediaType: item.format === 'MOVIE' ? MediaType.MOVIE : MediaType.SERIES,
    episodeCount: item.episodes || null,
    status: item.status || 'UNKNOWN',
    poster,
    genres: item.genres || [],
    provider: 'anilist',
    providerId: item.id,
    category: categoryId,
    format: item.format,
    relations: relations.map(r => ({
      id: r.id,
      title: typeof r.title === 'string'
        ? r.title
        : (r.title?.romaji || r.title?.english || r.title?.native || ''),
      relationType: r.relationType,
      format: r.format
    }))
  };
}

function normalizeJikanMedia(item, categoryId) {
  const type = item.type || 'TV';
  const isMovie = type === 'Movie';
  const mediaType = isMovie ? MediaType.MOVIE : MediaType.SERIES;
  const aliases = [];
  if (item.title) aliases.push(item.title);
  if (item.title_english) aliases.push(item.title_english);
  if (item.title_japanese) aliases.push(item.title_japanese);
  if (item.synonyms) aliases.push(...item.synonyms);

  let poster = '';
  if (item.images?.jpg) {
    poster = item.images.jpg.large_image_url || item.images.jpg.image_url;
  } else if (item.images?.webp) {
    poster = item.images.webp.large_image_url || item.images.webp.image_url;
  }
  if (poster && poster.startsWith('http://')) poster = poster.replace('http://', 'https://');

  const statusMap = {
    'Finished Airing': 'FINISHED',
    'Currently Airing': 'RELEASING',
    'Not yet aired': 'NOT_YET_RELEASED'
  };

  return {
    id: `jikan:${item.mal_id}`,
    title: item.title_english || item.title || item.title_japanese || 'Unknown',
    aliases: aliases.filter(Boolean),
    year: item.year || null,
    mediaType,
    episodeCount: item.episodes || null,
    status: statusMap[item.status] || item.status || 'UNKNOWN',
    poster,
    genres: item.genres?.map(g => g.name) || [],
    provider: 'jikan',
    providerId: item.mal_id,
    category: categoryId,
    format: type,
    relations: []
  };
}

function normalizeTmdbMedia(item, categoryId) {
  const isMovie = item.media_type === 'movie' || item.release_date;
  let poster = item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '';
  if (poster && poster.startsWith('http://')) poster = poster.replace('http://', 'https://');
  return {
    id: `tmdb:${item.id}`,
    title: item.title || item.name || 'Unknown',
    aliases: [item.title || item.name || ''],
    year: (item.release_date || item.first_air_date || '').substring(0, 4) || null,
    mediaType: isMovie ? MediaType.MOVIE : MediaType.SERIES,
    episodeCount: null,
    status: item.status || 'UNKNOWN',
    poster,
    genres: item.genre_ids || [],
    provider: 'tmdb',
    providerId: item.id,
    category: categoryId,
    format: isMovie ? 'MOVIE' : 'TV',
    relations: []
  };
}

function mediaToCard(media) {
  return {
    id: media.id,
    title: media.title,
    aliases: media.aliases,
    subtitle: media.mediaType === MediaType.MOVIE ? `Film · ${media.year || 'Latest'}` : `Series · ${media.year || 'Latest'}`,
    category: media.category,
    mediaType: media.mediaType,
    year: media.year,
    episodeCount: media.episodeCount,
    poster: media.poster,
    provider: media.provider,
    providerId: media.providerId,
    status: media.status,
    format: media.format,
    relationsRaw: media.relationsRaw || [],
    hasRelease: false,
    hasBatch: false
  };
}

module.exports = {
  fetchAniList,
  searchAnilistByTitle,
  fetchTmdb,
  searchJikan,
  normalizeAniListMedia,
  normalizeJikanMedia,
  normalizeTmdbMedia,
  mediaToCard
};
