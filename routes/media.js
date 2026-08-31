const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ApiError } = require('../middleware/errorHandler');
const { getCache, setCache } = require('../services/cacheService');
const { categoryConfig, CoverageType, TRUSTED_GROUPS, MediaType } = require('../config');
const { fetchAniList, searchAnilistByTitle, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia } = require('../services/metadataService');
const { searchReleasesWithFallback } = require('../services/torrentService');
const logger = require('../services/logger');

function getCategory(id) { return categoryConfig[id] || null; }

const releasesSchema = Joi.object({
  id: Joi.string().required(),
  category: Joi.string().valid('anime', 'tokusatsu').required(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  title: Joi.string().allow('').optional(),
  force: Joi.boolean().default(false)
});

const batchReleasesSchema = Joi.object({
  items: Joi.array().items(Joi.object({
    id: Joi.string().required(),
    category: Joi.string().valid('anime', 'tokusatsu').required(),
    title: Joi.string().allow('').optional()
  })).min(1).max(50).required()
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
    logger.warn({ err, title }, 'Jikan fallback failed');
  }
  if (process.env.TMDB_API_KEY) {
    try {
      const tmdbResults = await fetchTmdb('search/tv', { query: title, page: 1 });
      const filtered = tmdbResults.filter(item => item.genre_ids?.includes(16) && item.original_language === 'ja');
      if (filtered.length > 0) {
        return normalizeTmdbMedia(filtered[0], categoryId);
      }
    } catch (err) {
      logger.warn({ err, title }, 'TMDB fallback failed');
    }
  }
  return null;
}

function pickBestRelease(releases) {
  if (!releases.length) return null;
  const order = {
    [CoverageType.COMPLETE]: 0,
    [CoverageType.PARTIAL]: 1,
    [CoverageType.SINGLE]: 2,
    [CoverageType.UNKNOWN]: 3,
  };
  const confidenceOrder = { high: 0, medium: 1, low: 2 };
  const MIN_SEEDERS = 5;
  let candidates = releases.filter(r => (r.seeders || 0) >= MIN_SEEDERS);
  if (!candidates.length) candidates = releases;
  const sorted = [...candidates].sort((a, b) => {
    const covDiff = (order[a.coverageType] ?? 3) - (order[b.coverageType] ?? 3);
    if (covDiff !== 0) return covDiff;
    const confDiff = (confidenceOrder[a.confidence] ?? 3) - (confidenceOrder[b.confidence] ?? 3);
    if (confDiff !== 0) return confDiff;
    return b.score - a.score;
  });
  return sorted[0];
}

async function getMediaObject(mediaId, categoryId, title) {
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
            id title { romaji english native } synonyms seasonYear coverImage { medium large } format episodes chapters status genres isAdult
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
      if (rawMedia) return normalizeAniListMedia(rawMedia, categoryId, relations);
    } catch (err) {
      logger.warn({ err, mediaId }, 'AniList detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId);
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
        return normalizeJikanMedia(data.data, categoryId);
      }
    } catch (err) {
      logger.warn({ err, mediaId }, 'Jikan detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId);
    }
  } else if (provider === 'tmdb') {
    if (!process.env.TMDB_API_KEY) throw new ApiError(503, 'TMDB API key not configured', 'TMDB_KEY_MISSING');
    try {
      const config = getCategory(categoryId);
      const mediaType = config.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
      const url = `https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        return normalizeTmdbMedia(data, categoryId);
      }
    } catch (err) {
      logger.warn({ err, mediaId }, 'TMDB detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId);
    }
  }
  return null;
}

router.get('/releases', validate(releasesSchema, 'query'), asyncHandler(async (req, res) => {
  let mediaId = req.query.id;
  const categoryId = req.query.category;
  const page = req.query.page;
  const limit = req.query.limit;
  let title = req.query.title || '';
  const force = req.query.force === true || req.query.force === 'true';

  if (force) {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      throw new ApiError(403, 'Invalid admin token', 'FORBIDDEN');
    }
  }

  const config = getCategory(categoryId);
  if (!config) throw new ApiError(400, 'Invalid category', 'INVALID_CATEGORY');

  if (mediaId.startsWith('franchise:')) {
    if (!title) {
      throw new ApiError(400, 'Title required for franchise ID', 'FRANCHISE_REQUIRES_TITLE');
    }
    const media = await searchAnilistByTitle(title);
    if (!media) {
      throw new ApiError(404, 'Media not found', 'MEDIA_NOT_FOUND');
    }
    mediaId = `anilist:${media.id}`;
    title = media.title?.romaji || media.title?.english || title;
  }

  let mediaObject = null;
  let releases = [];

  const cacheKey = `releases:${categoryId}:${mediaId}`;
  const cacheKeyWithForce = force ? `${cacheKey}:force:${Date.now()}` : `${cacheKey}:force:false`;

  if (!force) {
    const cached = await getCache(cacheKeyWithForce);
    if (cached) {
      mediaObject = cached.media;
      releases = cached.releases;
      return res.json({
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
        best: pickBestRelease(releases),
        torrents: releases.slice((page - 1) * limit, page * limit),
        hasMore: page * limit < releases.length,
        lowConfidenceCount: releases.filter(r => r.confidence === 'low').length
      });
    }
  }

  mediaObject = await getMediaObject(mediaId, categoryId, title);
  if (!mediaObject) throw new ApiError(404, 'Media not found', 'MEDIA_NOT_FOUND');

  releases = await searchReleasesWithFallback(mediaObject, force);

  const singleEpisodes = releases.filter(r => r.coverageType === CoverageType.SINGLE && r.episodeStart !== null);
  const nonSingles = releases.filter(r => r.coverageType !== CoverageType.SINGLE || r.episodeStart === null);
  const episodeMap = new Map();
  for (const ep of singleEpisodes) {
    const key = ep.episodeStart;
    const existing = episodeMap.get(key);
    if (!existing || ep.seeders > existing.seeders || (ep.seeders === existing.seeders && ep.quality > existing.quality)) {
      episodeMap.set(key, ep);
    }
  }
  const dedupedSingles = Array.from(episodeMap.values());
  releases = [...dedupedSingles, ...nonSingles];
  releases.sort((a, b) => {
    if (a.coverageType === CoverageType.SINGLE && b.coverageType === CoverageType.SINGLE) {
      return (a.episodeStart || 0) - (b.episodeStart || 0);
    }
    if (a.coverageType === CoverageType.SINGLE) return 1;
    if (b.coverageType === CoverageType.SINGLE) return -1;
    return b.score - a.score;
  });

  if (!force) {
    await setCache(cacheKeyWithForce, { media: mediaObject, releases }, 43200);
  }

  const high = releases.filter(r => r.confidence === 'high');
  const med = releases.filter(r => r.confidence === 'medium');
  const low = releases.filter(r => r.confidence === 'low');
  const best = pickBestRelease(releases);

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

router.post('/releases/batch', validate(batchReleasesSchema, 'body'), asyncHandler(async (req, res) => {
  const { items } = req.body;
  const results = [];

  const fetchPromises = items.map(async (item) => {
    try {
      const config = getCategory(item.category);
      if (!config) return { id: item.id, error: 'Invalid category' };
      let mediaId = item.id;
      let title = item.title || '';
      if (mediaId.startsWith('franchise:')) {
        if (!title) return { id: item.id, error: 'Title required for franchise' };
        const media = await searchAnilistByTitle(title);
        if (!media) return { id: item.id, error: 'Media not found' };
        mediaId = `anilist:${media.id}`;
        title = media.title?.romaji || media.title?.english || title;
      }
      const mediaObject = await getMediaObject(mediaId, item.category, title);
      if (!mediaObject) return { id: item.id, error: 'Media object not found' };
      const releases = await searchReleasesWithFallback(mediaObject, false);
      const singles = releases.filter(r => r.coverageType === CoverageType.SINGLE && r.episodeStart !== null);
      const nonSingles = releases.filter(r => r.coverageType !== CoverageType.SINGLE || r.episodeStart === null);
      const epMap = new Map();
      for (const ep of singles) {
        const key = ep.episodeStart;
        const existing = epMap.get(key);
        if (!existing || ep.seeders > existing.seeders || (ep.seeders === existing.seeders && ep.quality > existing.quality)) {
          epMap.set(key, ep);
        }
      }
      const deduped = Array.from(epMap.values());
      const sorted = [...deduped, ...nonSingles].sort((a, b) => {
        if (a.coverageType === CoverageType.SINGLE && b.coverageType === CoverageType.SINGLE) {
          return (a.episodeStart || 0) - (b.episodeStart || 0);
        }
        if (a.coverageType === CoverageType.SINGLE) return 1;
        if (b.coverageType === CoverageType.SINGLE) return -1;
        return b.score - a.score;
      });
      return {
        id: item.id,
        title: mediaObject.title,
        releases: sorted,
        total: sorted.length
      };
    } catch (err) {
      logger.warn({ err, item }, 'Batch release item failed');
      return { id: item.id, error: err.message };
    }
  });

  const settledResults = await Promise.allSettled(fetchPromises);
  for (const result of settledResults) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      logger.warn({ err: result.reason }, 'Batch promise rejected');
    }
  }

  res.json({ results });
}));

router.post('/recommendations', validate(recommendationsSchema, 'body'), asyncHandler(async (req, res) => {
  const { bookmarks = [] } = req.body;
  if (!process.env.GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, recommendations disabled');
    return res.json({ items: [] });
  }
  if (bookmarks.length === 0) {
    return res.json({ items: [] });
  }

  const titles = bookmarks.map(b => b.title).filter(Boolean).join(', ');
  const prompt = `Given these anime/tokusatsu titles: ${titles}. Recommend 6 similar titles. Return only a JSON array of objects with fields: title, subtitle (e.g., "Series · 2022 · 12 eps"), category (anime or tokusatsu), mediaType (series or movie), year, poster (empty string).`;

  try {
    const result = await callGroq(prompt);
    let items = [];
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        items = parsed.slice(0, 6).map(item => ({
          ...item,
          id: `rec:${Date.now()}-${Math.random()}`
        }));
      }
    } catch (_) {
      const match = result.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            items = parsed.slice(0, 6).map(item => ({
              ...item,
              id: `rec:${Date.now()}-${Math.random()}`
            }));
          }
        } catch (__) {}
      }
    }
    res.json({ items });
  } catch (err) {
    logger.error({ err }, 'Recommendations error');
    res.json({ items: [] });
  }
}));

router.post('/ai-search', validate(aiSearchSchema, 'body'), asyncHandler(async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, AI search disabled');
    throw new ApiError(503, 'Groq not configured', 'GROQ_NOT_CONFIGURED');
  }
  const prompt = req.body.prompt;
  const result = await callGroq(`Parse this user media search prompt into structured JSON filters: "${prompt}"`);
  res.json({ success: true, filters: result });
}));

async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
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
