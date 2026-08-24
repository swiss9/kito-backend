const express = require('express');
const router = express.Router();
const { categoryConfig, MediaType } = require('../config');
const { fetchAniList, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia, mediaToCard } = require('../services/metadataService');
const { stripSeasonInfo } = require('../utils');

function getCategories() { return Object.keys(categoryConfig); }
function getCategory(id) { return categoryConfig[id] || null; }

function extractSeasonFromTitle(title) {
  if (!title) return null;
  const clean = title.replace(/\[.*?\]|\(.*?\)/g, ' ');
  const ordinalMatch = clean.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  if (ordinalMatch) return parseInt(ordinalMatch[1]);
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
          category: s.category
        });
      }
    }

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
      seasons: uniqueSeasons
    });
  }
  return results;
}

router.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const categoryId = req.query.category || 'any';
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 20;
    const group = req.query.group === 'true';

    if (!q) {
      return res.json({ query: q, category: categoryId, items: [], page, perPage, total: 0 });
    }

    const categories = categoryId === 'any' ? getCategories() : [categoryId];
    let allResults = [];

    for (const catId of categories) {
      const config = getCategory(catId);
      if (!config) continue;

      if (config.metadataProvider === 'anilist') {
        let items = [];
        try {
          const query = `
            query($search: String, $type: MediaType, $page: Int, $perPage: Int) {
              Page(page: $page, perPage: $perPage) {
                pageInfo { hasNextPage }
                media(search: $search, type: $type, sort: SEARCH_MATCH) {
                  id title { romaji english native } synonyms seasonYear coverImage { medium large } format episodes chapters status genres
                }
              }
            }
          `;
          const type = 'ANIME';
          const variables = { search: q, type, page: 1, perPage: 50 };
          const data = await fetchAniList(query, variables);
          items = (data.Page.media || []).map(item => {
            const media = normalizeAniListMedia(item, catId, []);
            return mediaToCard(media);
          });
        } catch (err) {
          console.warn(`AniList failed: ${err.message}`);
        }

        if (items.length === 0) {
          try {
            const jikanData = await searchJikan(q);
            items = jikanData.map(item => {
              const media = normalizeJikanMedia(item, catId);
              return mediaToCard(media);
            });
          } catch (err) {
            console.warn(`Jikan failed: ${err.message}`);
          }
        }

        if (items.length === 0 && process.env.TMDB_API_KEY) {
          try {
            let tmdbResults = await fetchTmdb('search/tv', { query: q, page: 1 });
            if (!tmdbResults.length) {
              tmdbResults = await fetchTmdb('search/movie', { query: q, page: 1 });
            }
            items = tmdbResults.map(item => {
              const media = normalizeTmdbMedia(item, catId);
              return mediaToCard(media);
            });
          } catch (err) {
            console.warn(`TMDB fallback failed: ${err.message}`);
          }
        }
        allResults.push(...items);
      }

      if (config.metadataProvider === 'tmdb' && process.env.TMDB_API_KEY) {
        try {
          const mediaType = config.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
          const params = { query: q, page: 1 };
          if (catId === 'hollywood') params.region = 'US';
          else if (catId === 'bollywood') params.region = 'IN';
          const url = new URL(`https://api.themoviedb.org/3/search/${mediaType}`);
          url.searchParams.set('api_key', process.env.TMDB_API_KEY);
          url.searchParams.set('language', 'en-US');
          for (const [key, val] of Object.entries(params)) {
            if (val) url.searchParams.set(key, val);
          }
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (res.ok) {
            const data = await res.json();
            let results = data.results || [];
            if (catId === 'bollywood') {
              results = results.filter(item => item.original_language === 'hi');
            } else if (catId === 'asian') {
              results = results.filter(item => ['ja', 'ko', 'zh'].includes(item.original_language));
            } else if (catId === 'animation') {
              results = results.filter(item => item.genre_ids?.includes(16));
            } else if (catId === 'tokusatsu') {
              results = results.filter(item => item.original_language === 'ja');
            }
            const items = results.map(item => {
              const media = normalizeTmdbMedia(item, catId);
              return mediaToCard(media);
            });
            allResults.push(...items);
          }
        } catch (err) {
          console.warn(`TMDB error: ${err.message}`);
        }
      }
    }

    // Filter out unreleased entries
    allResults = allResults.filter(item => item.status !== 'NOT_YET_RELEASED');

    let unique = [];
    if (group) {
      const seriesItems = allResults.filter(item => item.mediaType === MediaType.SERIES);
      const movieItems = allResults.filter(item => item.mediaType === MediaType.MOVIE);

      const groupedSeries = groupByFranchise(seriesItems);
      const collections = groupedSeries.filter(item => item.collection);
      const standaloneSeries = groupedSeries.filter(item => !item.collection);

      // Gather all IDs that are part of collections
      const collectionSeasonIds = new Set();
      collections.forEach(c => {
        c.seasons.forEach(s => collectionSeasonIds.add(s.id));
      });

      // Remove individual series entries that are already covered by a collection
      const filteredStandaloneSeries = standaloneSeries.filter(item => !collectionSeasonIds.has(item.id));

      unique = [...collections, ...filteredStandaloneSeries, ...movieItems];

      // Remove duplicate IDs
      const seen = new Set();
      unique = unique.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });

      // Hide individual movies that are part of a franchise collection
      const finalCollections = unique.filter(item => item.collection);
      const finalNonCollections = unique.filter(item => !item.collection);

      const filteredNonCollections = finalNonCollections.filter(item => {
        if (item.mediaType === MediaType.MOVIE) {
          const movieTitle = item.title.toLowerCase();
          return !finalCollections.some(c => {
            const base = c.title.toLowerCase();
            return movieTitle === base ||
                   movieTitle.startsWith(base + ' ') ||
                   movieTitle.startsWith(base + ':');
          });
        }
        return true;
      });

      unique = [...finalCollections, ...filteredNonCollections];
    } else {
      const seen = new Set();
      unique = allResults.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    }

    const start = (page - 1) * perPage;
    const end = start + perPage;
    const paginated = unique.slice(start, end);
    const total = unique.length;

    res.json({
      query: q,
      category: categoryId,
      page,
      perPage,
      total,
      items: paginated,
      hasMore: end < total
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({
      query: req.query.q || '',
      category: req.query.category || 'any',
      page: parseInt(req.query.page) || 1,
      perPage: parseInt(req.query.perPage) || 20,
      total: 0,
      items: [],
      error: err.message || 'Search failed'
    });
  }
});

module.exports = router;
