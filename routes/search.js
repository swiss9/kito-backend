const express = require('express');
const router = express.Router();
const { categoryConfig } = require('../config');
const { fetchAniList, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia, mediaToCard } = require('../services/metadataService');
const { MediaType } = require('../config');

function getCategories() { return Object.keys(categoryConfig); }
function getCategory(id) { return categoryConfig[id] || null; }

router.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const categoryId = req.query.category || 'any';
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 20;

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
          // Fetch first page with a higher perPage to get enough results for pagination
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

    // Deduplicate across categories
    const seen = new Set();
    const unique = allResults.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    // Local pagination after aggregation
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
