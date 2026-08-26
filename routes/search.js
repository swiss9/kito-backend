const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { getCache, setCache } = require('../services/cacheService');
const { categoryConfig, MediaType } = require('../config');
const { fetchAniList, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia, mediaToCard } = require('../services/metadataService');
const { stripSeasonInfo, normalizeTitle, escapeRegex } = require('../utils');

const queryCorrections = {
  'yourname': 'your name',
  'kamenrider': 'kamen rider',
  'supersentai': 'super sentai',
  'ultraman': 'ultraman',
  'dragonball': 'dragon ball',
  'dragonballz': 'dragon ball z',
  'dragonballsuper': 'dragon ball super',
  'narutoshippuden': 'naruto shippuden',
  'onepiece': 'one piece',
  'attackontitan': 'attack on titan'
};

function normalizeSearchQuery(raw) {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (queryCorrections[lower]) {
    return queryCorrections[lower];
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
      subtitle: `${seasons.length} seasons${minYear ? ` · ${minYear}${maxYear && maxYear !== minYear ? '–' + maxYear : ''}` : ''}`,
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

router.get('/search', validate(searchSchema, 'query'), asyncHandler(async (req, res) => {
  const { q, category, page, perPage, group, force } = req.query;

  const normalizedQuery = normalizeSearchQuery(q);
  const normalizedQ = normalizedQuery.trim().toLowerCase();

  if (force) {
    console.log(`[force] Bypassing cache for query "${normalizedQ}"`);
  }

  const cacheKey = `search:${category}:${normalizedQ}:page:${page}:perPage:${perPage}:group:${group}`;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) {
      console.log(`[cache] HIT for "${normalizedQ}"`);
      return res.json(cached);
    }
  }

  console.log(`[search] Processing "${normalizedQ}"`);

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
                id title { romaji english native } synonyms seasonYear coverImage { medium large } format episodes chapters status genres isAdult
              }
            }
          }
        `;
        const variables = { search: normalizedQuery, type: 'ANIME', page: 1, perPage: 50 };
        const data = await fetchAniList(query, variables);
        items = (data.Page.media || []).map(item => mediaToCard(normalizeAniListMedia(item, catId, [])));
      } catch (err) {
        console.warn(`AniList failed: ${err.message}`);
      }

      if (items.length === 0) {
        try {
          const jikanData = await searchJikan(normalizedQuery);
          items = jikanData.map(item => mediaToCard(normalizeJikanMedia(item, catId)));
        } catch (err) {
          console.warn(`Jikan failed: ${err.message}`);
        }
      }

      if (items.length === 0 && process.env.TMDB_API_KEY) {
        try {
          let tmdbResults = await fetchTmdb('search/tv', { query: normalizedQuery, page: 1 });
          tmdbResults = tmdbResults.filter(i => i.genre_ids?.includes(16) && i.original_language === 'ja');
          if (!tmdbResults.length) {
            const movieResults = await fetchTmdb('search/movie', { query: normalizedQuery, page: 1 });
            tmdbResults = movieResults.filter(i => i.genre_ids?.includes(16) && i.original_language === 'ja');
          }
          items = tmdbResults.map(item => mediaToCard(normalizeTmdbMedia(item, catId))).filter(Boolean);
        } catch (err) {
          console.warn(`TMDB fallback failed: ${err.message}`);
        }
      }
      allResults.push(...items);
    }

    if (catId === 'tokusatsu' && process.env.TMDB_API_KEY) {
      try {
        const mediaTypes = ['tv', 'movie'];
        let tokusatsuItems = [];
        const genreIds = [28, 12, 878, 14];
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
                item.genre_ids &&
                item.genre_ids.some(id => genreIds.includes(id))
              );
            const items = results.map(item => mediaToCard(normalizeTmdbMedia(item, catId))).filter(Boolean);
            tokusatsuItems.push(...items);
          } catch (err) {
            console.warn(`TMDB search ${type} failed: ${err.message}`);
          }
        }
        allResults.push(...tokusatsuItems);
      } catch (err) {
        console.warn(`Tokusatsu TMDB error: ${err.message}`);
      }
    }
  }

  allResults = allResults.filter(item => item && item.status !== 'NOT_YET_RELEASED');
  allResults = allResults.filter(item => item && !item.isAdult);

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
    console.log(`[filter] Exact match found for "${normalizedQueryTitle}", filtering...`);
    const phraseRegex = new RegExp(`\\b${escapeRegex(normalizedQueryTitle)}\\b`, 'i');
    let filtered = allResults.filter(item => {
      const titles = [item.title, ...(item.aliases || [])].map(t => normalizeTitle(t));
      return titles.some(t => phraseRegex.test(t));
    });

    if (filtered.length > 10) {
      const mediaTypes = [...new Set(filtered.map(item => item.mediaType))];
      if (mediaTypes.length > 1) {
        const dominantType = mediaTypes
          .map(type => ({ type, count: filtered.filter(i => i.mediaType === type).length }))
          .sort((a, b) => b.count - a.count)[0].type;
        filtered = filtered.filter(item => item.mediaType === dominantType);
        console.log(`[filter] Reduced to media type ${dominantType} (${filtered.length} results)`);
      }
    }
    allResults = filtered;
  } else {
    console.log(`[filter] No exact match, skipping phrase filter`);
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
  } else {
    console.log(`[force] Not caching result for "${normalizedQ}"`);
  }

  res.json(responseData);
}));

module.exports = router;
