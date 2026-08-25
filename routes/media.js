const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ApiError } = require('../middleware/errorHandler');
const { getCached, setCache } = require('../utils');
const { categoryConfig, CoverageType, TRUSTED_GROUPS, MediaType } = require('../config');
const { fetchAniList, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia } = require('../services/metadataService');
const { searchReleases } = require('../services/torrentService');

function getCategory(id) { return categoryConfig[id] || null; }

const releasesSchema = Joi.object({
  id: Joi.string().pattern(/^(anilist|jikan|tmdb):\d+$/).required(),
  category: Joi.string().valid('anime', 'tokusatsu').required(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  title: Joi.string().allow('').optional()
});

const recommendationsSchema = Joi.object({
  bookmarks: Joi.array().items(Joi.object()).optional()
});

const aiSearchSchema = Joi.object({
  prompt: Joi.string().trim().min(1).max(500).required()
});

async function fallbackFetchAnimeByTitle(title, categoryId) {
  let media = null;

  try {
    const jikanResults = await searchJikan(title);
    if (jikanResults.length > 0) {
      return normalizeJikanMedia(jikanResults[0], categoryId);
    }
  } catch (err) {
    console.warn(`Jikan fallback failed: ${err.message}`);
  }

  if (process.env.TMDB_API_KEY) {
    try {
      const tmdbResults = await fetchTmdb('search/tv', { query: title, page: 1 });
      const filtered = tmdbResults.filter(item => item.genre_ids?.includes(16) && item.original_language === 'ja');
      if (filtered.length > 0) {
        return normalizeTmdbMedia(filtered[0], categoryId);
      }
    } catch (err) {
      console.warn(`TMDB fallback failed: ${err.message}`);
    }
  }

  return null;
}

router.get('/releases', validate(releasesSchema, 'query'), asyncHandler(async (req, res) => {
  const mediaId = req.query.id;
  const categoryId = req.query.category;
  const page = req.query.page;
  const limit = req.query.limit;
  const title = req.query.title || '';

  const config = getCategory(categoryId);
  if (!config) {
    throw new ApiError(400, 'Invalid category', 'INVALID_CATEGORY');
  }

  const cacheKey = `releases:${categoryId}:${mediaId}`;
  const cached = getCached(cacheKey);
  let mediaObject = null;
  let releases = [];

  if (cached) {
    mediaObject = cached.media;
    releases = cached.releases;
  } else {
    const provider = mediaId.startsWith('anilist') ? 'anilist' :
                     mediaId.startsWith('jikan') ? 'jikan' : 'tmdb';
    const providerId = mediaId.split(':')[1];
    let rawMedia = null;
    let relations = [];

    if (provider === 'anilist') {
      try {
        const query = `
          query($id: Int) {
            Media(id: $id) {
              id title { romaji english native } synonyms seasonYear coverImage { medium large } format episodes chapters status genres
              relations {
                edges {
                  relationType
                  node { id title { romaji english native } format }
                }
              }
            }
          }
        `;
        const data = await fetchAniList(query, { id: parseInt(providerId) });
        rawMedia = data.Media;
        if (rawMedia?.relations?.edges) {
          relations = rawMedia.relations.edges.map(e => ({
            relationType: e.relationType,
            node: e.node
          }));
        }
        if (rawMedia) mediaObject = normalizeAniListMedia(rawMedia, categoryId, relations);
      } catch (err) {
        console.warn(`AniList detail failed: ${err.message}`);
        if (title) mediaObject = await fallbackFetchAnimeByTitle(title, categoryId);
      }
    } else if (provider === 'jikan') {
      try {
        const url = `https://api.jikan.moe/v4/anime/${providerId}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'KITO/1.0' },
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = await res.json();
          mediaObject = normalizeJikanMedia(data.data, categoryId);
        }
      } catch (err) {
        console.warn(`Jikan detail failed: ${err.message}`);
        if (title) mediaObject = await fallbackFetchAnimeByTitle(title, categoryId);
      }
    } else if (provider === 'tmdb') {
      if (!process.env.TMDB_API_KEY) {
        throw new ApiError(503, 'TMDB API key not configured', 'TMDB_KEY_MISSING');
      }
      try {
        const mediaType = config.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
        const url = `https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          mediaObject = normalizeTmdbMedia(data, categoryId);
        }
      } catch (err) {
        console.warn(`TMDB detail failed: ${err.message}`);
        if (title) mediaObject = await fallbackFetchAnimeByTitle(title, categoryId);
      }
    }

    if (mediaObject) {
      releases = await searchReleases(mediaObject);
      setCache(cacheKey, { media: mediaObject, releases });
    }
  }

  if (!mediaObject) {
    throw new ApiError(404, 'Media not found', 'MEDIA_NOT_FOUND');
  }

  const high = releases.filter(r => r.confidence === 'high');
  const med = releases.filter(r => r.confidence === 'medium');
  const low = releases.filter(r => r.confidence === 'low');
  const best = high.length > 0 ? high[0] : med.length > 0 ? med[0] : low.length > 0 ? low[0] : null;

  const start = (page - 1) * limit;
  const end = start + limit;
  const paginated = releases.slice(start, end);

  res.json({
    mediaId,
    category: categoryId,
    media: {
      title: mediaObject.title,
      aliases: mediaObject.aliases,
      poster: mediaObject.poster,
      year: mediaObject.year,
      mediaType: mediaObject.mediaType,
      episodeCount: mediaObject.episodeCount,
      genres: mediaObject.genres,
      status: mediaObject.status
    },
    total: releases.length,
    page,
    limit,
    best: best ? {
      name: best.name,
      magnet: best.magnet,
      size: best.size,
      seeders: best.seeders,
      leechers: best.leechers,
      uploader: best.uploader,
      type: best.coverageType,
      quality: best.qualityLabel,
      description: best.coverageType === CoverageType.COMPLETE ? 'Complete series' :
                  best.coverageType === CoverageType.PARTIAL ? `Episodes ${best.episodeStart}-${best.episodeEnd} (${best.coveragePercent}%)` :
                  best.coverageType === CoverageType.SINGLE ? `Episode ${best.episodeStart}` :
                  'Unknown coverage',
      score: best.score,
      confidence: best.confidence,
      releaseGroup: best.releaseGroup,
      isTrusted: TRUSTED_GROUPS.some(g => best.releaseGroup && best.releaseGroup.toLowerCase().includes(g.toLowerCase()))
    } : null,
    torrents: paginated.map(r => ({
      name: r.name,
      magnet: r.magnet,
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      uploader: r.uploader,
      type: r.coverageType,
      quality: r.qualityLabel,
      description: r.coverageType === CoverageType.COMPLETE ? 'Complete series' :
                  r.coverageType === CoverageType.PARTIAL ? `Episodes ${r.episodeStart}-${r.episodeEnd} (${r.coveragePercent}%)` :
                  r.coverageType === CoverageType.SINGLE ? `Episode ${r.episodeStart}` :
                  'Unknown coverage',
      score: r.score,
      confidence: r.confidence,
      releaseGroup: r.releaseGroup,
      isTrusted: TRUSTED_GROUPS.some(g => r.releaseGroup && r.releaseGroup.toLowerCase().includes(g.toLowerCase()))
    })),
    hasMore: end < releases.length,
    lowConfidenceCount: low.length
  });
}));

router.post('/recommendations', validate(recommendationsSchema, 'body'), asyncHandler(async (req, res) => {
  // Placeholder for future recommendation logic
  res.json({ items: [] });
}));

router.post('/ai-search', validate(aiSearchSchema, 'body'), asyncHandler(async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    throw new ApiError(503, 'Groq not configured', 'GROQ_NOT_CONFIGURED');
  }

  const prompt = req.body.prompt;
  const result = await callGroq(`Parse this user media search prompt into structured JSON filters: "${prompt}"`);
  res.json({ success: true, filters: result });
}));

async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'You are a media search parser. Extract structured filters from user queries. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new ApiError(res.status, `Groq API error: ${res.status}`, 'GROQ_API_ERROR');
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

module.exports = router;
