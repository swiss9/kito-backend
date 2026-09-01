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
          label: s.title
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

    results.push({
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
      hasRelease: false,
      hasBatch: false,
      collection: true,
      seasons: finalSeasons,
      movies: []
    });
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

function cleanTitleForMatch(title) {
  if (!title) return '';
  return title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(Series|TV|Movie|Film|Special|OVA|ONA|Anime|Episode|Batch|Complete|Season|Collection|Edition|Version|Remastered|Dub|Sub|BD|DVD|BluRay|WEB|DL|1080p|720p|480p|360p|4k|HD|SD|HEVC|x264|x265|HDR|10bit|8bit|Multi-Subs|Multi-Audio|Dual-Audio|Eng|Jap|JPN|ENG|Multi)[:\s]*/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function deduplicateSearchResults(items) {
  const merged = new Map();
  for (const item of items) {
    const keyTitle = cleanTitleForMatch(item.title);
    const year = item.year || '';
    const key = `${keyTitle}|${year}`;

    if (merged.has(key)) {
      const existing = merged.get(key);
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
      } else if (item.provider === 'tmdb' && existing.provider !== 'anilist') {
        if (item.poster && !existing.poster) existing.poster = item.poster;
        if (item.subtitle && !existing.subtitle) existing.subtitle = item.subtitle;
        if (item.episodeCount && !existing.episodeCount) existing.episodeCount = item.episodeCount;
        if (item.genres && item.genres.length > existing.genres.length) existing.genres = item.genres;
        if (item.popularity && item.popularity > existing.popularity) existing.popularity = item.popularity;
        if (item.aliases) existing.aliases = [...new Set([...existing.aliases, ...item.aliases])];
        if (!existing.category && item.category) existing.category = item.category;
      }
    } else {
      merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values());
}

router.get('/search', validate(searchSchema, 'query'), asyncHandler(async (req, res) => {
  const { q, category, page, perPage, group, force } = req.query;

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
      try {
        const query = `
          query($search: String, $type: MediaType, $page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
              pageInfo { hasNextPage }
              media(search: $search, type: $type, sort: SEARCH_MATCH) {
                id title { romaji english native } synonyms seasonYear coverImage { medium large } format episodes chapters status genres isAdult popularity
              }
            }
          }
        `;
        const variables = { search: normalizedQuery, type: 'ANIME', page: 1, perPage: 50 };
        const data = await fetchAniList(query, variables);
        items = (data.Page.media || []).map(item => mediaToCard(normalizeAniListMedia(item, catId, [])));
      } catch (err) {
        req.logger.warn({ err }, 'AniList failed');
      }

      if (items.length === 0) {
        try {
          const jikanData = await searchJikan(normalizedQuery);
          items = jikanData.map(item => mediaToCard(normalizeJikanMedia(item, catId)));
        } catch (err) {
          req.logger.warn({ err }, 'Jikan failed');
        }
      }

      if (items.length === 0 && process.env.TMDB_API_KEY) {
        try {
          let tmdbResults = await fetchTmdb('search/tv', { query: normalizedQuery, page: 1 });
          tmdbResults = tmdbResults.filter(i => 
            i.genre_ids?.includes(16) && 
            i.original_language === 'ja' && 
            i.origin_country?.includes('JP')
          );
          if (!tmdbResults.length) {
            const movieResults = await fetchTmdb('search/movie', { query: normalizedQuery, page: 1 });
            tmdbResults = movieResults.filter(i => 
              i.genre_ids?.includes(16) && 
              i.original_language === 'ja' && 
              i.origin_country?.includes('JP')
            );
          }
          items = tmdbResults.map(item => mediaToCard(normalizeTmdbMedia(item, catId))).filter(Boolean);
        } catch (err) {
          req.logger.warn({ err }, 'TMDB fallback failed');
        }
      }
      allResults.push(...items);
    }

    if (catId === 'tokusatsu' && process.env.TMDB_API_KEY) {
      try {
        const mediaTypes = ['tv', 'movie'];
        let tokusatsuItems = [];
        for (const type of mediaTypes) {
          const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
          url.searchParams.set('api_key', process.env.TMDB_API_KEY);
          url.searchParams.set('language', 'en-US');
          url.searchParams.set('query', normalizedQuery);
          url.searchParams.set('page', 1);

          try {
            const data = await fetchTmdbSearchWithRetry(url.toString());
            const results = (data.results || [])
              .filter(item =>
                item.original_language === 'ja' &&
                item.origin_country?.includes('JP')
              );
            const items = results.map(item => mediaToCard(normalizeTmdbMedia(item, catId))).filter(Boolean);
            tokusatsuItems.push(...items);
          } catch (err) {
            req.logger.warn({ err }, `TMDB search ${type} failed`);
          }
        }
        allResults.push(...tokusatsuItems);
      } catch (err) {
        req.logger.warn({ err }, 'Tokusatsu TMDB error');
      }
    }
  }

  allResults = allResults.filter(item => item && item.status !== 'NOT_YET_RELEASED');
  allResults = allResults.filter(item => item && !item.isAdult);

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
    const phraseRegex = new RegExp(`\\b${escapeRegex(normalizedQueryTitle)}\\b`, 'i');
    allResults = allResults.filter(item => {
      const titles = [item.title, ...(item.aliases || [])].map(t => normalizeTitle(t));
      return titles.some(t => phraseRegex.test(t));
    });

    allResults.sort((a, b) => {
      const aExact = a.title === normalizedQueryTitle || (a.aliases || []).some(t => normalizeTitle(t) === normalizedQueryTitle);
      const bExact = b.title === normalizedQueryTitle || (b.aliases || []).some(t => normalizeTitle(t) === normalizedQueryTitle);
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return (b.popularity || 0) - (a.popularity || 0);
    });

    const topResult = allResults[0];
    if (topResult && (topResult.mediaType === MediaType.MOVIE || (topResult.popularity && topResult.popularity > 50))) {
      const targetMediaType = topResult.mediaType;
      allResults = allResults.filter(item => item.mediaType === targetMediaType);

      if (targetMediaType === MediaType.MOVIE) {
        allResults = allResults.filter(item => {
          const titles = [item.title, ...(item.aliases || [])].map(t => normalizeTitle(t));
          return titles.some(t => t === normalizedQueryTitle);
        });
      }
    }
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
      ttlSeconds = 3600;
    } else if (unique.length < 3) {
      ttlSeconds = 7200;
    } else {
      ttlSeconds = 21600;
    }
    await setCache(cacheKey, responseData, ttlSeconds);
  }

  res.json(responseData);
}));

module.exports = router;
