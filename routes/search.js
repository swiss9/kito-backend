const express = require('express');
const router = express.Router();
const { categoryConfig, MediaType } = require('../config');
const { fetchAniList, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia, mediaToCard } = require('../services/metadataService');
const { stripSeasonInfo } = require('../utils');

function getCategories() { return Object.keys(categoryConfig); }
function getCategory(id) { return categoryConfig[id] || null; }

// ---------- Union-Find ----------
class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  makeSet(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x) {
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)));
    }
    return this.parent.get(x);
  }
  union(x, y) {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return;
    this.parent.set(rootY, rootX);
  }
}

// ---------- Helpers ----------
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

// Build collections from union-find groups
function buildCollectionsFromGroups(groups, allAnimeItems) {
  const results = [];
  for (const group of groups) {
    const items = group.items;
    const series = items.filter(item => item.mediaType === MediaType.SERIES);
    const movies = items.filter(item => item.mediaType === MediaType.MOVIE);

    if (series.length === 0) {
      // pure movie group: keep each movie standalone
      movies.forEach(m => results.push(m));
      continue;
    }

    if (series.length === 1 && movies.length === 0) {
      // single standalone series
      results.push(series[0]);
      continue;
    }

    // We have a collection
    // Sort series by season number (or year)
    series.sort((a, b) => {
      const sa = extractSeasonFromTitle(a.title) ?? (a.year || 1);
      const sb = extractSeasonFromTitle(b.title) ?? (b.year || 1);
      return sa - sb;
    });

    const first = series[0];
    const cleanTitle = removeSeasonInfoFromTitle(first.title) || first.title;
    const years = series.map(s => s.year).filter(Boolean);
    const minYear = years.length ? Math.min(...years) : null;
    const maxYear = years.length ? Math.max(...years) : null;
    const poster = series.find(s => s.poster)?.poster || first.poster;
    const provider = first.provider;
    const providerId = first.providerId;
    const aliases = [...new Set(series.flatMap(s => s.aliases || []))];

    // Deduplicate seasons by ID
    const uniqueSeasons = [];
    const seenIds = new Set();
    for (const s of series) {
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
          label: s.title   // original title for display
        });
      }
    }

    // Deduplicate movies
    const uniqueMovies = [];
    const seenMovieIds = new Set();
    for (const m of movies) {
      if (!seenMovieIds.has(m.id)) {
        seenMovieIds.add(m.id);
        uniqueMovies.push({
          id: m.id,
          title: m.title,
          subtitle: m.subtitle,
          year: m.year,
          poster: m.poster,
          provider: m.provider,
          providerId: m.providerId,
          category: m.category
        });
      }
    }

    results.push({
      id: `franchise:${first.id}`,
      title: cleanTitle,
      aliases,
      subtitle: `${uniqueSeasons.length} seasons${minYear ? ` · ${minYear}${maxYear && maxYear !== minYear ? '–' + maxYear : ''}` : ''}`,
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
      seasons: uniqueSeasons,
      movies: uniqueMovies
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

    // We'll collect anime items separately to build union-find later
    let animeItemsWithRelations = [];

    for (const catId of categories) {
      const config = getCategory(catId);
      if (!config) continue;

      if (config.id === 'anime') {
        let items = [];
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
                  relations {
                    edges {
                      relationType
                      node {
                        id
                        title { romaji english native }
                        format
                      }
                    }
                  }
                }
              }
            }
          `;
          const type = 'ANIME';
          const variables = { search: q, type, page: 1, perPage: 50 };
          const data = await fetchAniList(query, variables);
          const rawMediaList = data.Page.media || [];
          items = rawMediaList.map(raw => {
            const media = normalizeAniListMedia(raw, catId, []);
            // Store raw relations for union-find
            media.relationsRaw = raw.relations?.edges?.map(e => ({
              relationType: e.relationType,
              nodeId: e.node.id
            })) || [];
            return mediaToCard(media);
          });
          // Keep anime items with their relations
          animeItemsWithRelations = animeItemsWithRelations.concat(items);
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
            animeItemsWithRelations = animeItemsWithRelations.concat(items);
          } catch (err) {
            console.warn(`Jikan failed: ${err.message}`);
          }
        }

        if (items.length === 0 && process.env.TMDB_API_KEY) {
          try {
            let tmdbResults = await fetchTmdb('search/tv', { query: q, page: 1 });
            tmdbResults = tmdbResults.filter(item => 
              item.genre_ids?.includes(16) && item.original_language === 'ja'
            );
            if (!tmdbResults.length) {
              const movieResults = await fetchTmdb('search/movie', { query: q, page: 1 });
              tmdbResults = movieResults.filter(item => 
                item.genre_ids?.includes(16) && item.original_language === 'ja'
              );
            }
            items = tmdbResults.map(item => {
              const media = normalizeTmdbMedia(item, catId);
              return mediaToCard(media);
            });
            animeItemsWithRelations = animeItemsWithRelations.concat(items);
          } catch (err) {
            console.warn(`TMDB fallback failed: ${err.message}`);
          }
        }
        allResults.push(...items);
      }

      if (config.id === 'tokusatsu' && process.env.TMDB_API_KEY) {
        try {
          const mediaType = config.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
          const url = new URL(`https://api.themoviedb.org/3/search/${mediaType}`);
          url.searchParams.set('api_key', process.env.TMDB_API_KEY);
          url.searchParams.set('language', 'en-US');
          url.searchParams.set('query', q);
          url.searchParams.set('page', 1);
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (res.ok) {
            const data = await res.json();
            let results = data.results || [];
            results = results.filter(item => item.original_language === 'ja');
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

    // Filter out unreleased
    allResults = allResults.filter(item => item.status !== 'NOT_YET_RELEASED');

    let unique = [];
    if (group) {
      // We'll group only anime items (both series and movies)
      const animeItems = allResults.filter(item => item.category === 'anime');
      const otherItems = allResults.filter(item => item.category !== 'anime');

      // Build Union-Find on all anime items (series + movies)
      const uf = new UnionFind();
      const idToItem = new Map();
      animeItems.forEach(item => {
        uf.makeSet(item.id);
        idToItem.set(item.id, item);
      });

      // Also map AniList numeric IDs to item IDs for relation union
      const anilistIdToItemId = new Map();
      for (const item of animeItems) {
        if (item.provider === 'anilist') {
          anilistIdToItemId.set(item.providerId, item.id);
        }
      }

      // Union based on relations
      for (const item of animeItems) {
        if (item.relationsRaw) {
          for (const rel of item.relationsRaw) {
            if (['SEQUEL','PREQUEL','SPIN_OFF','ALTERNATIVE','SIDE_STORY'].includes(rel.relationType)) {
              const relatedItemId = anilistIdToItemId.get(rel.nodeId);
              if (relatedItemId && relatedItemId !== item.id) {
                uf.union(item.id, relatedItemId);
              }
            }
          }
        }
      }

      // Group items by root
      const groupMap = new Map();
      for (const item of animeItems) {
        const root = uf.find(item.id);
        if (!groupMap.has(root)) {
          groupMap.set(root, []);
        }
        groupMap.get(root).push(item);
      }

      // Build collections from groups
      const animeGroups = Array.from(groupMap.values()).map(items => ({ items }));
      const collections = buildCollectionsFromGroups(animeGroups, animeItems);

      // Filter out standalone series/movies that became part of a collection
      const collectionIds = new Set();
      collections.forEach(c => {
        if (c.collection) {
          c.seasons.forEach(s => collectionIds.add(s.id));
          c.movies.forEach(m => collectionIds.add(m.id));
        }
      });

      // But we also need to keep standalone items that are not collections
      const standaloneAnime = collections.filter(item => !item.collection);
      const collectionsOnly = collections.filter(item => item.collection);

      // Combine: collections + standalone anime + other items (tokusatsu)
      unique = [...collectionsOnly, ...standaloneAnime, ...otherItems];

      // Deduplicate by ID
      const seen = new Set();
      unique = unique.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
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
