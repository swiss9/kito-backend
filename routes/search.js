const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ApiError } = require('../middleware/errorHandler');
const { getCache, setCache } = require('../services/cacheService');
const { categoryConfig, MediaType, QUERY_CORRECTIONS } = require('../config');
const { fetchAniList, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia, mediaToCard } = require('../services/metadataService');
const { stripSeasonInfo, normalizeTitle, escapeRegex } = require('../utils');
const { getFranchise } = require('../services/rankingService');

const TOKUSATSU_FRANCHISES = [
  'kamen rider', 'ultraman', 'super sentai', 'garo', 'godzilla',
  'mothra', 'zone fighter', 'gridman', 'ssss.gridman', 'ssss.dynazenon',
  'goranger', 'battle fever j'
];
const TOKUSATSU_KEYWORD_ID = '317204';

function normalizeSearchQuery(raw) {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (QUERY_CORRECTIONS[lower]) {
    return QUERY_CORRECTIONS[lower];
  }
  return trimmed;
}

function getCategories() { return Object.keys(categoryConfig); }
function getCategory(id) { return categoryConfig[id] || null; }

function extractSeasonFromTitle(title) {
  if (!title) return null;
  const clean = title.replace(/\[.*?\]|\(.*?\)/g, ' ');
  const ordinalMap = {
    'first': 1,
    'second': 2,
    'third': 3,
    'fourth': 4,
    'fifth': 5,
    'sixth': 6,
    'seventh': 7,
    'eighth': 8,
    'ninth': 9,
    'tenth': 10
  };
  const wordMatch = clean.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/i);
  if (wordMatch) return ordinalMap[wordMatch[1].toLowerCase()];
  const numericOrdinal = clean.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  if (numericOrdinal) return parseInt(numericOrdinal[1]);
  const romanMap = { 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6 };
  const romanMatch = clean.match(/\b(II|III|IV|V|VI)\b/);
  if (romanMatch) return romanMap[romanMatch[1]];
  const patterns = [
    /[Ss]eason\s*(\d+)/i,
    /S(\d+)\s*Complete/i,
    /\b(\d+)$/
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      const s = parseInt(match[1]);
      if (s > 0 && s < 100) return s;
    }
  }
  return null;
}

function removeSeasonInfoFromTitle(title) {
  if (!title) return '';
  return title
    .replace(/\b(\d+)(?:st|nd|rd|th)\s*season\b/gi, '')
    .replace(/\bseason\s*\d+\b/gi, '')
    .replace(/\bS\d+\b/gi, '')
    .replace(/\bpart\s*\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupByFranchise(items) {
  const groups = {};
  for (const item of items) {
    const base = stripSeasonInfo(item.title);
    if (!base) continue;
    if (!groups[base]) groups[base] = [];
    groups[base].push(item);
  }

  const results = [];
  for (const base in groups) {
    const seasons = groups[base];
    if (seasons.length === 1) {
      results.push(seasons[0]);
      continue;
    }

    seasons.sort((a, b) => {
      const sa = extractSeasonFromTitle(a.title) ?? 1;
      const sb = extractSeasonFromTitle(b.title) ?? 1;
      return sa - sb;
    });

    const first = seasons[0];
    const cleanTitle = removeSeasonInfoFromTitle(first.title) || first.title;
    const years = seasons.map(s => s.year).filter(Boolean);
    const minYear = years.length ? Math.min(...years) : null;
    const maxYear = years.length ? Math.max(...years) : null;
    const poster = seasons.find(s => s.poster)?.poster || first.poster;
    const provider = first.provider;
    const providerId = first.providerId;
    const aliases = [...new Set(seasons.flatMap(s => s.aliases || []))];

    const uniqueSeasons = [];
    const seenIds = new Set();
    for (const s of seasons) {
      if (!seenIds.has(s.id)) {
        seenIds.add(s.id);
        uniqueSeasons.push({
          id: s.id,
          title: s.title,
          subtitle: s.subtitle,
          year: s.year,
          poster: s.poster,
          seasonNumber: extractSeasonFromTitle(s.title) ?? 1,
          provider: s.provider,
          providerId: s.providerId,
          category: s.category,
          label: s.title,
          hasRelease: s.hasRelease || false,
          hasBatch: s.hasBatch || false
        });
      }
    }

    const seasonMap = new Map();
    for (const s of uniqueSeasons) {
      if (!seasonMap.has(s.seasonNumber)) {
        seasonMap.set(s.seasonNumber, s);
      }
    }
    const finalSeasons = Array.from(seasonMap.values());

    const collection = {
      id: `franchise:${base}`,
      title: cleanTitle,
      aliases,
      subtitle: `${seasons.length} seasons${minYear ? ` Â· ${minYear}${maxYear && maxYear !== minYear ? 'â€“' + maxYear : ''}` : ''}`,
      category: first.category,
      mediaType: 'collection',
      year: minYear,
      episodeCount: null,
      poster,
      provider,
      providerId,
      hasRelease: finalSeasons.some(s => s.hasRelease),
      hasBatch: finalSeasons.some(s => s.hasBatch),
      collection: true,
      seasons: finalSeasons,
      movies: []
    };

    const batchKeywords = [/complete series/i, /seasons?\s*[\d-]+/i, /complete collection/i, /full season/i, /all episodes/i];
    const batchSeason = finalSeasons.find(s => batchKeywords.some(re => re.test(s.label)));
    if (batchSeason) {
      collection.seasons = [batchSeason];
    }

    results.push(collection);
  }
  return results;
}

const searchSchema = Joi.object({
  q: Joi.string().trim().min(1).max(200).required(),
  category: Joi.string().valid('anime', 'tokusatsu', 'any').default('any'),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(50).default(20),
  group: Joi.boolean().default(false),
  force: Joi.boolean().default(false)
});

async function fetchTmdbSearchWithRetry(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * attempt;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        throw new Error(`TMDB HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastError || new Error('TMDB request failed');
}

async function fetchTmdbDiscoverWithKeyword(keywordId, page = 1) {
  const baseUrl = 'https://api.themoviedb.org/3/discover/tv';
  const url = new URL(baseUrl);
  url.searchParams.set('api_key', process.env.TMDB_API_KEY);
  url.searchParams.set('with_keywords', keywordId);
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('page', page);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function fetchAniListWithRetry(query, variables, retries = 3) {
  const delays = [1000, 2000, 5000];
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchAniList(query, variables);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = delays[attempt] || 5000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function cleanTitleForMatch(title) {
  if (!title) return '';
  const titleAliases = {
    'shin seiki evangelion': 'neon genesis evangelion',
    'shin seiki': 'neon genesis',
    'evangelion: death (true)2': 'neon genesis evangelion: death',
    'evangelion: death': 'neon genesis evangelion: death',
    'the end of evangelion': 'neon genesis evangelion: the end'
  };
  let lower = title.toLowerCase();
  for (const [from, to] of Object.entries(titleAliases)) {
    if (lower.includes(from)) lower = lower.replace(from, to);
  }
  const parts = lower.split(/[?!:\-([/]/);
  let cleaned = parts[0] || lower;
  cleaned = cleaned
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(Series|TV|Movie|Film|Special|OVA|ONA|Anime|Episode|Batch|Complete|Season|Collection|Edition|Version|Remastered|Dub|Sub|BD|DVD|BluRay|WEB|DL|1080p|720p|480p|360p|4k|HD|SD|HEVC|x264|x265|HDR|10bit|8bit|Multi-Subs|Multi-Audio|Dual-Audio|Eng|Jap|JPN|ENG|Multi)[:\s]*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return cleaned;
}

function tokenOverlap(str1, str2) {
  const tokens1 = str1.split(/\s+/);
  const tokens2 = str2.split(/\s+/);
  if (tokens1.length === 0 || tokens2.length === 0) return 0;
  const common = tokens1.filter(t => tokens2.includes(t)).length;
  const total = Math.max(tokens1.length, tokens2.length);
  return common / total;
}

function getNonFranchiseTokens(title, franchise) {
  const cleaned = cleanTitleForMatch(title);
  const parts = cleaned.split(/\s+/);
  const franchiseLower = franchise.toLowerCase();
  return parts.filter(t => t !== franchiseLower && t.length > 2);
}

function deduplicateSearchResults(items) {
  const merged = new Map();
  const fallbackMap = new Map();

  for (const item of items) {
    const keyTitle = cleanTitleForMatch(item.title);
    const year = item.year || '';
    const primaryKey = `${keyTitle}|${year}`;

    if (merged.has(primaryKey)) {
      const existing = merged.get(primaryKey);
      if (item.provider === 'anilist') {
        existing.provider = 'anilist';
        existing.providerId = item.providerId;
        if (item.poster) existing.poster = item.poster;
        if (item.subtitle) existing.subtitle = item.subtitle;
        if (item.episodeCount) existing.episodeCount = item.episodeCount;
        if (item.genres && item.genres.length > existing.genres.length) existing.genres = item.genres;
        if (item.popularity && item.popularity > existing.popularity) existing.popularity = item.popularity;
        if (item.aliases) existing.aliases = [...new Set([...existing.aliases, ...item.aliases])];
        if (!existing.category && item.category) existing.category = item.category;
        if (item.countryOfOrigin && !existing.countryOfOrigin) existing.countryOfOrigin = item.countryOfOrigin;
      } else if (item.provider === 'tmdb' && existing.provider !== 'anilist') {
        if (item.poster && !existing.poster) existing.poster = item.poster;
        if (item.subtitle && !existing.subtitle) existing.subtitle = item.subtitle;
        if (item.episodeCount && !existing.episodeCount) existing.episodeCount = item.episodeCount;
        if (item.genres && item.genres.length > existing.genres.length) existing.genres = item.genres;
        if (item.popularity && item.popularity > existing.popularity) existing.popularity = item.popularity;
        if (item.aliases) existing.aliases = [...new Set([...existing.aliases, ...item.aliases])];
        if (!existing.category && item.category) existing.category = item.category;
        if (item.origin_country && !existing.origin_country) existing.origin_country = item.origin_country;
      }
    } else {
      merged.set(primaryKey, { ...item });
    }
  }

  const mergedItems = Array.from(merged.values());

  for (const item of mergedItems) {
    const franchise = getFranchise({ title: item.title });
    if (!franchise) continue;
    const year = item.year || '';
    const fallbackKey = `${franchise}|${year}`;
    if (fallbackMap.has(fallbackKey)) {
      const existing = fallbackMap.get(fallbackKey);
      const cleanedTitle = cleanTitleForMatch(item.title);
      const existingCleaned = cleanTitleForMatch(existing.title);
      const overlap = tokenOverlap(cleanedTitle, existingCleaned);
      if (overlap > 0.6) {
        const nonFranchiseTokens1 = getNonFranchiseTokens(item.title, franchise);
        const nonFranchiseTokens2 = getNonFranchiseTokens(existing.title, franchise);
        const commonNonFranchise = nonFranchiseTokens1.filter(t => nonFranchiseTokens2.includes(t));
        if (commonNonFranchise.length > 0) {
          if (item.provider === 'anilist') {
            existing.provider = 'anilist';
            existing.providerId = item.providerId;
            if (item.poster) existing.poster = item.poster;
            if (item.subtitle) existing.subtitle = item.subtitle;
            if (item.episodeCount) existing.episodeCount = item.episodeCount;
            if (item.genres && item.genres.length > existing.genres.length) existing.genres = item.genres;
            if (item.popularity && item.popularity > existing.popularity) existing.popularity = item.popularity;
            if (item.aliases) existing.aliases = [...new Set([...existing.aliases, ...item.aliases])];
            if (!existing.category && item.category) existing.category = item.category;
            if (item.countryOfOrigin && !existing.countryOfOrigin) existing.countryOfOrigin = item.countryOfOrigin;
          }
        }
      }
    } else {
      fallbackMap.set(fallbackKey, { ...item });
    }
  }

  return Array.from(fallbackMap.values());
}

router.get('/search', validate(searchSchema, 'query'), asyncHandler(async (req, res) => {
  const { q, category, page, perPage, group, force } = req.query;
  const { logger } = req;

  logger.info({ query: q, category, page, perPage, group, force }, 'Search request received');

  if (force === true || force === 'true') {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      throw new ApiError(403, 'Invalid admin token', 'FORBIDDEN');
    }
  }

  const normalizedQuery = normalizeSearchQuery(q);
  const normalizedQ = normalizedQuery.trim().toLowerCase();

  let cacheKey = `search:${category}:${normalizedQ}:page:${page}:perPage:${perPage}:group:${group}`;
  if (force) {
    cacheKey += `:force:${Date.now()}`;
  } else {
    cacheKey += ':force:false';
  }

  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) {
      logger.info({ cacheKey, total: cached.total }, 'Search cache hit');
      return res.json(cached);
    }
  }

  const categories = category === 'any' ? getCategories() : [category];
  let allResults = [];

  for (const catId of categories) {
    const config = getCategory(catId);
    if (!config) continue;

    if (catId === 'anime') {
      let items = [];
      let pageNum = 1;
      const maxPages = 3;
      const perPageAni = 50;
      const seenIds = new Set();

      while (pageNum <= maxPages) {
        try {
          const query = `
            query($search: String, $type: MediaType, $page: Int, $perPage: Int) {
              Page(page: $page, perPage: $perPage) {
                pageInfo { hasNextPage }
                media(search: $search, type: $type, sort: SEARCH_MATCH) {
                  id
                  title { romaji english native }
                  synonyms
                  seasonYear
                  coverImage { medium large }
                  format
                  episodes
                  chapters
                  status
                  genres
                  isAdult
                  popularity
                  countryOfOrigin
                }
              }
            }
          `;
          const variables = { search: normalizedQuery, type: 'ANIME', page: pageNum, perPage: perPageAni };
          const data = await fetchAniListWithRetry(query, variables);
          const rawItems = data.Page.media || [];
          if (!rawItems.length) break;
          const mapped = rawItems
            .map(item => mediaToCard(normalizeAniListMedia(item, catId, [])))
            .filter(item => item && item.status !== 'NOT_YET_RELEASED' && !item.isAdult);
          for (const item of mapped) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              items.push(item);
            }
          }
          if (!data.Page.pageInfo.hasNextPage) break;
          pageNum++;
        } catch (err) {
          logger.warn({ err, pageNum, provider: 'anilist' }, 'AniList search page failed');
          break;
        }
      }

      if (items.length === 0) {
        try {
          const jikanData = await searchJikan(normalizedQuery);
          items = jikanData.map(item => mediaToCard(normalizeJikanMedia(item, catId)));
          logger.info({ count: items.length, provider: 'jikan' }, 'Jikan fallback results');
        } catch (err) {
          logger.warn({ err, provider: 'jikan' }, 'Jikan search failed');
        }
      }

      if (items.length === 0 && process.env.TMDB_API_KEY) {
        try {
          let tmdbResults = await fetchTmdb('search/tv', { query: normalizedQuery, page: 1 });
          const tmdbAnimeResults = tmdbResults.filter(i =>
            i.genre_ids?.includes(16) &&
            i.original_language === 'ja' &&
            i.origin_country?.includes('JP')
          );
          if (tmdbAnimeResults.length) {
            items = tmdbAnimeResults.map(item => mediaToCard(normalizeTmdbMedia(item, catId))).filter(Boolean);
          } else {
            const movieResults = await fetchTmdb('search/movie', { query: normalizedQuery, page: 1 });
            const movieAnime = movieResults.filter(i =>
              i.genre_ids?.includes(16) &&
              i.original_language === 'ja' &&
              i.origin_country?.includes('JP')
            );
            if (movieAnime.length) {
              items = movieAnime.map(item => mediaToCard(normalizeTmdbMedia(item, catId))).filter(Boolean);
            }
          }
          logger.info({ count: items.length, provider: 'tmdb' }, 'TMDB fallback results');
        } catch (err) {
          logger.warn({ err, provider: 'tmdb' }, 'TMDB fallback failed');
        }
      }

      if (items.length > 0) {
        logger.info({ count: items.length, provider: 'anime', category: catId }, 'Search results found for anime category');
      } else {
        logger.warn({ query: normalizedQuery, category: catId }, 'No results found for anime category');
      }

      allResults.push(...items);
    }

    if (catId === 'tokusatsu' && process.env.TMDB_API_KEY) {
      try {
        let tokusatsuItems = [];
        let page = 1;
        const maxPages = 2;
        while (page <= maxPages) {
          const results = await fetchTmdbDiscoverWithKeyword(TOKUSATSU_KEYWORD_ID, page);
          if (!results.length) break;
          for (const item of results) {
            if (item.original_language !== 'ja') continue;
            if (!item.origin_country || !item.origin_country.includes('JP')) continue;

            const mapped = mediaToCard(normalizeTmdbMedia(item, catId));
            if (mapped) tokusatsuItems.push(mapped);
          }
          page++;
        }

        if (tokusatsuItems.length === 0) {
          const searchResults = await fetchTmdb('search/tv', { query: normalizedQuery, page: 1 });
          const filtered = searchResults.filter(item =>
            item.original_language === 'ja' &&
            item.origin_country?.includes('JP') &&
            TOKUSATSU_FRANCHISES.some(f =>
              (item.title || '').toLowerCase().includes(f) ||
              (item.original_title || '').toLowerCase().includes(f) ||
              (item.overview || '').toLowerCase().includes(f)
            )
          );
          const mapped = filtered.map(item => mediaToCard(normalizeTmdbMedia(item, catId))).filter(Boolean);
          tokusatsuItems = mapped;
        }

        if (tokusatsuItems.length > 0) {
          logger.info({ count: tokusatsuItems.length, provider: 'tmdb', category: catId }, 'Search results found for tokusatsu category');
        }
        allResults.push(...tokusatsuItems);
      } catch (err) {
        logger.warn({ err, category: catId }, 'Tokusatsu TMDB error');
      }
    }
  }

  allResults = allResults.filter(item => item && item.status !== 'NOT_YET_RELEASED');
  allResults = allResults.filter(item => item && !item.isAdult);

  allResults = allResults.filter(item => {
    if (item.category === 'anime') {
      const country = item.countryOfOrigin || item.origin_country || '';
      if (country && !['JP', 'CN'].includes(country)) return false;
      if (item.title && /\b(3d|cgi|computer graphics|computer-generated)\b/i.test(item.title)) return false;
    }
    return true;
  });

  allResults = deduplicateSearchResults(allResults);

  const seenAnilistIds = new Set();
  allResults = allResults.filter(item => {
    if (item.provider === 'anilist') {
      if (seenAnilistIds.has(item.providerId)) return false;
      seenAnilistIds.add(item.providerId);
    }
    return true;
  });

  const normalizedQueryTitle = normalizeTitle(normalizedQuery);
  const exactMatchItems = allResults.filter(item => {
    const titles = [item.title, ...(item.aliases || [])].map(t => normalizeTitle(t));
    return titles.some(t => t === normalizedQueryTitle);
  });

  if (exactMatchItems.length > 0) {
    const queryTokens = normalizedQueryTitle.split(/\s+/).filter(t => t.length > 1);
    allResults = allResults.filter(item => {
      const titles = [item.title, ...(item.aliases || [])].map(t => normalizeTitle(t));
      return titles.some(t => {
        const titleTokens = t.split(/\s+/).filter(w => w.length > 1);
        const common = queryTokens.filter(w => titleTokens.includes(w));
        const overlap = common.length / Math.max(queryTokens.length, titleTokens.length, 1);
        return overlap >= 0.5;
      });
    });

    allResults.sort((a, b) => {
      const aExact = a.title === normalizedQueryTitle || (a.aliases || []).some(t => normalizeTitle(t) === normalizedQueryTitle);
      const bExact = b.title === normalizedQueryTitle || (b.aliases || []).some(t => normalizeTitle(t) === normalizedQueryTitle);
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return (b.popularity || 0) - (a.popularity || 0);
    });
  }

  let unique = [];
  if (group) {
    const seriesItems = allResults.filter(item => item.mediaType === MediaType.SERIES);
    const movieItems = allResults.filter(item => item.mediaType === MediaType.MOVIE);
    const animeSeries = seriesItems.filter(item => item.category === 'anime');
    const otherSeries = seriesItems.filter(item => item.category !== 'anime');

    const groupedAnime = groupByFranchise(animeSeries);
    const collections = groupedAnime.filter(item => item.collection);
    const standaloneAnime = groupedAnime.filter(item => !item.collection);

    const collectionSeasonIds = new Set();
    collections.forEach(c => c.seasons.forEach(s => collectionSeasonIds.add(s.id)));
    const filteredStandaloneAnime = standaloneAnime.filter(item => !collectionSeasonIds.has(item.id));

    const collectionsWithMovies = collections.map(c => {
      const matchingMovies = movieItems.filter(m => {
        const movieTitle = m.title.toLowerCase();
        const base = c.title.toLowerCase();
        return movieTitle === base || movieTitle.startsWith(base + ' ') || movieTitle.startsWith(base + ':');
      });
      return { ...c, movies: matchingMovies };
    });

    const attachedMovieIds = new Set();
    collectionsWithMovies.forEach(c => c.movies.forEach(m => attachedMovieIds.add(m.id)));
    const standaloneMovies = movieItems.filter(m => !attachedMovieIds.has(m.id));

    unique = [...collectionsWithMovies, ...filteredStandaloneAnime, ...otherSeries, ...standaloneMovies];

    const seen = new Set();
    unique = unique.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    const collectionsForMovieCheck = unique.filter(item => item.collection);
    if (collectionsForMovieCheck.length > 0) {
      const collectionIndicators = /movie collection|complete series.*movies|movies.*complete series|full collection|completed/i;
      const hasCompleteWithMovies = collectionsForMovieCheck.some(c =>
        c.title?.toLowerCase().includes('movie') ||
        c.seasons?.some(s => collectionIndicators.test(s.title))
      );
      if (hasCompleteWithMovies) {
        unique = unique.filter(item => !(item.mediaType === MediaType.MOVIE && !item.collection));
      }
    }
  } else {
    unique = allResults;
  }

  const tokusatsuKeywords = /\b(kamen\s*rider|ultraman|super\s*sentai)\b/i;
  if (tokusatsuKeywords.test(normalizedQuery)) {
    unique.sort((a, b) => {
      const aTokusatsu = a.category === 'tokusatsu' ? 1 : 0;
      const bTokusatsu = b.category === 'tokusatsu' ? 1 : 0;
      if (aTokusatsu !== bTokusatsu) return bTokusatsu - aTokusatsu;
      return 0;
    });
  }

  const start = (page - 1) * perPage;
  const end = start + perPage;
  const paginated = unique.slice(start, end);

  const responseData = {
    query: q,
    category,
    page,
    perPage,
    total: unique.length,
    items: paginated,
    hasMore: end < unique.length
  };

  if (!force) {
    let ttlSeconds;
    if (unique.length === 0) {
      ttlSeconds = 300;
    } else if (unique.length < 3) {
      ttlSeconds = 7200;
    } else {
      ttlSeconds = 21600;
    }
    await setCache(cacheKey, responseData, ttlSeconds);
  }

  logger.info({ total: unique.length, returned: paginated.length, cacheKey }, 'Search response sent');
  res.json(responseData);
}));

module.exports = router;
