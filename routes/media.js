const express = require('express');
const router = express.Router();
const Joi = require('joi');
const crypto = require('crypto');
const { Ratelimit } = require('@upstash/ratelimit');
const rateLimit = require('express-rate-limit');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ApiError } = require('../middleware/errorHandler');
const { getCache, setCache } = require('../services/cacheService');
const { categoryConfig, CoverageType, TRUSTED_GROUPS, MediaType, TOKUSATSU_FRANCHISES } = require('../config');
const { fetchAniList, searchAnilistByTitle, fetchTmdb, searchKitsu, searchShikimori, fetchShikimori, normalizeAniListMedia, normalizeKitsuMedia, normalizeTmdbMedia, normalizeShikimoriMedia, mediaToCard } = require('../services/metadataService');
const { searchReleasesWithFallback } = require('../services/torrentService');
const { rankReleases, selectBestCandidates } = require('../services/releaseRankingService');
const { isValidAdminToken } = require('../utils');
const redisClient = require('../services/redisClient');
const logger = require('../services/logger');

const TOKUSATSU_KEYWORD_ID = '317204';

let batchRatelimit = null;
if (redisClient) {
  batchRatelimit = new Ratelimit({
    redis: redisClient,
    limiter: Ratelimit.slidingWindow(2, '1 m'),
    prefix: 'kito_batch_ratelimit',
  });
}

const batchLimiterMemory = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'BATCH_RATE_LIMIT', message: 'Too many batch requests' } }
});

async function batchRateLimiterMiddleware(req, res, next) {
  if (batchRatelimit) {
    try {
      const identifier = req.ip || 'anonymous';
      const { success, limit, remaining, reset } = await batchRatelimit.limit(identifier);
      res.setHeader('RateLimit-Limit', limit);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Reset', Math.ceil((reset - Date.now()) / 1000));
      if (!success) {
        return res.status(429).json({ error: { code: 'BATCH_RATE_LIMIT', message: 'Too many batch requests' } });
      }
      next();
    } catch (err) {
      req.logger?.warn({ err }, 'Batch rate limiter failed, falling back to memory');
      batchLimiterMemory(req, res, next);
    }
  } else {
    batchLimiterMemory(req, res, next);
  }
}

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
  })).min(1).max(10).required()
});

const recommendationsSchema = Joi.object({
  bookmarks: Joi.array().items(Joi.object({
    id: Joi.string().allow('').optional(),
    mediaId: Joi.string().allow('').optional(),
    title: Joi.string().max(200).allow('').optional(),
    category: Joi.string().valid('anime', 'tokusatsu').optional(),
    genres: Joi.array().items(Joi.string().max(50)).max(10).optional()
  })).max(25).optional()
});

const aiSearchSchema = Joi.object({
  prompt: Joi.string().trim().min(1).max(500).required()
});

function serializeRelease(r) {
  let description = 'Unknown coverage';
  const type = r.coverageType;

  if (type === 'complete_season' || type === 'complete_series' || type === CoverageType.COMPLETE) {
    description = 'Complete series';
  } else if (type === 'partial_batch' || type === 'episode_range' || type === CoverageType.PARTIAL) {
    description = `Episodes ${r.episodeStart}-${r.episodeEnd} (${r.coveragePercent || 0}%)`;
  } else if (type === 'single' || type === CoverageType.SINGLE) {
    description = `Episode ${r.episodeStart}`;
  } else if (type === 'movie') {
    description = 'Movie';
  }

  return {
    name: r.name,
    magnet: r.magnet,
    size: r.size,
    seeders: r.seeders,
    leechers: r.leechers,
    uploader: r.uploader,
    type: type,
    quality: r.qualityLabel,
    description: description,
    score: r.score,
    confidence: r.confidence,
    releaseGroup: r.releaseGroup,
    isTrusted: TRUSTED_GROUPS.some(g => r.releaseGroup && r.releaseGroup.toLowerCase().includes(g.toLowerCase()))
  };
}

async function checkTokusatsuKeyword(tmdbId, mediaType) {
  const cacheKey = `tokusatsu_keyword:${tmdbId}:${mediaType}`;
  const cached = await getCache(cacheKey);
  if (cached !== null) return cached;
  try {
    const data = await fetchTmdb(`${mediaType}/${tmdbId}/keywords`);
    const keywords = data.keywords || data.results || [];
    const isTokusatsu = keywords.some(k => k.id === parseInt(TOKUSATSU_KEYWORD_ID));
    await setCache(cacheKey, isTokusatsu, 604800);
    return isTokusatsu;
  } catch (err) {
    logger.warn({ err, tmdbId, mediaType }, 'Failed to check tokusatsu keyword');
    return false;
  }
}

async function searchTmdbTvByTitle(title, categoryId, logger) {
  if (!process.env.TMDB_API_KEY) {
    throw new ApiError(503, 'TMDB API key not configured', 'TMDB_KEY_MISSING');
  }
  if (!title) return null;

  try {
    let results = await fetchTmdb('search/tv', { query: title, page: 1 });
    let mediaType = 'tv';

    if (!results || !results.length) {
      results = await fetchTmdb('search/movie', { query: title, page: 1 });
      mediaType = 'movie';
    }
    if (!results || !results.length) return null;

    const japanese = results.filter(r =>
      r.original_language === 'ja' ||
      (Array.isArray(r.origin_country) && r.origin_country.includes('JP'))
    );
    const candidates = japanese.length ? japanese : results;

    let bestCandidate = null;
    for (const candidate of candidates.slice(0, 5)) {
      const isTokusatsu = await checkTokusatsuKeyword(candidate.id, mediaType);
      if (isTokusatsu) {
        bestCandidate = candidate;
        break;
      }
    }
    if (!bestCandidate && candidates.length > 0) {
      bestCandidate = candidates[0];
    }
    if (!bestCandidate) return null;

    const detailEndpoint = mediaType === 'tv' ? `tv/${bestCandidate.id}` : `movie/${bestCandidate.id}`;
    let detail = null;
    try {
      detail = await fetchTmdb(detailEndpoint, { language: 'en-US' });
    } catch (err) {
      logger.warn({ err, title, tmdbId: bestCandidate.id }, 'TMDB detail fetch failed after search match');
    }

    if (!detail) {
      return normalizeTmdbMedia(bestCandidate, categoryId);
    }

    return normalizeTmdbMedia(detail, categoryId);
  } catch (err) {
    logger.warn({ err, title }, 'TMDB tokusatsu title search failed');
    return null;
  }
}

async function fallbackFetchAnimeByTitle(title, categoryId, logger) {
  if (categoryId === 'tokusatsu') {
    return await searchTmdbTvByTitle(title, categoryId, logger);
  }

  try {
    const shikimoriResults = await searchShikimori(title);
    if (shikimoriResults && shikimoriResults.length > 0) {
      return normalizeShikimoriMedia(shikimoriResults[0], categoryId);
    }
  } catch (err) {
    logger.warn({ err, title }, 'Shikimori fallback failed');
  }

  try {
    const kitsuResults = await searchKitsu(title);
    if (kitsuResults.length > 0) {
      return normalizeKitsuMedia(kitsuResults[0]);
    }
  } catch (err) {
    logger.warn({ err, title }, 'Kitsu fallback failed');
  }

  if (process.env.TMDB_API_KEY) {
    try {
      const tmdbResults = await fetchTmdb('search/tv', { query: title, page: 1 });
      const filtered = tmdbResults.filter(item => item.genre_ids?.includes(16) && item.original_language === 'ja');
      if (filtered.length > 0) {
        const detail = await fetchTmdb(`tv/${filtered[0].id}`, { language: 'en-US' });
        return normalizeTmdbMedia(detail || filtered[0], categoryId);
      }
    } catch (err) {
      logger.warn({ err, title }, 'TMDB fallback failed');
    }
  }
  return null;
}

async function getMediaObject(mediaId, categoryId, title, logger) {
  const detectedProvider = mediaId.startsWith('anilist') ? 'anilist' :
                           mediaId.startsWith('shikimori') ? 'shikimori' : 'tmdb';
  const providerId = mediaId.split(':')[1];

  if (categoryId === 'tokusatsu' && detectedProvider !== 'tmdb') {
    logger.info({ mediaId, title, detectedProvider }, 'Tokusatsu category - forcing TMDB title resolution');
    const tmdbMedia = await searchTmdbTvByTitle(title, categoryId, logger);
    if (tmdbMedia) return tmdbMedia;
    return null;
  }

  const provider = detectedProvider;
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
      if (rawMedia) {
        return normalizeAniListMedia(rawMedia, categoryId, relations);
      }
    } catch (err) {
      logger.warn({ err, provider: 'anilist', id: providerId }, 'AniList detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId, logger);
    }
  } else if (provider === 'shikimori') {
    try {
      const data = await fetchShikimori(`https://shikimori.one/api/animes/${providerId}`);
      return normalizeShikimoriMedia(data, categoryId);
    } catch (err) {
      logger.warn({ err, provider: 'shikimori', id: providerId }, 'Shikimori detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId, logger);
    }
  } else if (provider === 'tmdb') {
    if (!process.env.TMDB_API_KEY) throw new ApiError(503, 'TMDB API key not configured', 'TMDB_KEY_MISSING');
    try {
      const config = getCategory(categoryId);
      const mediaType = config.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
      const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`;
      const keywordUrl = `https://api.themoviedb.org/3/${mediaType}/${providerId}/keywords?api_key=${process.env.TMDB_API_KEY}`;
      const [detailRes, keywordRes] = await Promise.all([
        fetch(detailUrl, { signal: AbortSignal.timeout(8000) }),
        fetch(keywordUrl, { signal: AbortSignal.timeout(8000) })
      ]);
      if (!detailRes.ok) throw new Error(`TMDB detail HTTP ${detailRes.status}`);
      const data = await detailRes.json();
      let keywordData = {};
      let isTokusatsu = false;
      if (keywordRes.ok) {
        keywordData = await keywordRes.json();
        const keywords = keywordData.keywords || keywordData.results || [];
        isTokusatsu = keywords.some(k => k.id === parseInt(TOKUSATSU_KEYWORD_ID));
      }
      const cacheKey = `tokusatsu_keyword:${providerId}:${mediaType}`;
      await setCache(cacheKey, isTokusatsu, 604800);
      let resolvedCategory = categoryId;
      if (isTokusatsu && categoryId === 'anime') {
        resolvedCategory = 'tokusatsu';
      }
      const media = normalizeTmdbMedia(data, resolvedCategory);
      return media;
    } catch (err) {
      logger.warn({ err, provider: 'tmdb', id: providerId }, 'TMDB detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId, logger);
    }
  }
  return null;
}

router.get('/releases', validate(releasesSchema, 'query'), asyncHandler(async (req, res) => {
  const { logger } = req;
  let mediaId = req.query.id;
  let categoryId = req.query.category;
  const page = req.query.page;
  const limit = req.query.limit;
  let title = req.query.title || '';
  const force = req.query.force === true || req.query.force === 'true';

  logger.info({ mediaId, categoryId, title, page, limit, force }, 'Releases request received');

  if (force && !isValidAdminToken(req.headers['x-admin-token'])) {
    throw new ApiError(403, 'Invalid admin token', 'FORBIDDEN');
  }

  const config = getCategory(categoryId);
  if (!config) throw new ApiError(400, 'Invalid category', 'INVALID_CATEGORY');

  if (mediaId.startsWith('franchise:')) {
    if (!title) {
      throw new ApiError(400, 'Title required for franchise ID', 'FRANCHISE_REQUIRES_TITLE');
    }
    if (categoryId === 'tokusatsu') {
      const media = await searchTmdbTvByTitle(title, categoryId, logger);
      if (!media) {
        throw new ApiError(404, 'Media not found', 'MEDIA_NOT_FOUND');
      }
      mediaId = media.id;
      title = media.title;
    } else {
      const media = await searchShikimori(title);
      if (media && media.length > 0) {
        const normalized = normalizeShikimoriMedia(media[0], categoryId);
        mediaId = normalized.id;
        title = normalized.title;
      } else {
        throw new ApiError(404, 'Media not found', 'MEDIA_NOT_FOUND');
      }
    }
  }

  if (!mediaId) {
    throw new ApiError(400, 'Media ID required', 'MEDIA_ID_REQUIRED');
  }

  let mediaObject = await getMediaObject(mediaId, categoryId, title, logger);
  if (!mediaObject) {
    if (title) {
      mediaObject = await fallbackFetchAnimeByTitle(title, categoryId, logger);
      if (mediaObject) {
        logger.info({ mediaId, resolvedCategory: categoryId }, 'Fell back to title search for media');
      }
    }
    if (!mediaObject) throw new ApiError(404, 'Media not found', 'MEDIA_NOT_FOUND');
  }

  const cacheKey = `releases:${categoryId}:${mediaId}`;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) {
      logger.info({ cacheKey, total: cached.releases.length }, 'Releases cache hit');
      const start = (page - 1) * limit;
      const end = start + limit;
      const paginatedReleases = cached.releases.slice(start, end);
      const bestRelease = cached.releases.length ? cached.releases[0] : null;
      return res.json({
        mediaId,
        category: categoryId,
        media: {
          title: cached.media.title,
          aliases: cached.media.aliases,
          poster: cached.media.poster,
          year: cached.media.year,
          mediaType: cached.media.mediaType,
          episodeCount: cached.media.episodeCount,
          genres: cached.media.genres,
          status: cached.media.status
        },
        total: cached.releases.length,
        page,
        limit,
        best: bestRelease ? serializeRelease(bestRelease) : null,
        torrents: paginatedReleases.map(serializeRelease),
        hasMore: end < cached.releases.length,
        lowConfidenceCount: cached.releases.filter(r => r.confidence === 'low').length,
        warnings: cached.warnings || [],
        rateLimited: cached.rateLimited || false
      });
    }
  }

  const torrentResult = await searchReleasesWithFallback(mediaObject, force, logger);
  const rawReleases = torrentResult.releases;
  const warnings = torrentResult.warnings;
  const rateLimited = torrentResult.rateLimited;

  const ranked = rankReleases(mediaObject, rawReleases, null);
  const selected = selectBestCandidates(ranked, mediaObject, null);

  if (!force) {
    await setCache(cacheKey, { media: mediaObject, releases: selected, warnings, rateLimited }, 43200);
  }

  const start = (page - 1) * limit;
  const end = start + limit;
  const paginated = selected.slice(start, end);

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
    total: selected.length,
    page,
    limit,
    best: selected.length ? serializeRelease(selected[0]) : null,
    torrents: paginated.map(serializeRelease),
    hasMore: end < selected.length,
    lowConfidenceCount: selected.filter(r => r.confidence === 'low').length,
    warnings,
    rateLimited
  });
}));

router.post('/releases/batch', batchRateLimiterMiddleware, validate(batchReleasesSchema, 'body'), asyncHandler(async (req, res) => {
  const { logger } = req;
  const { items } = req.body;
  const CHUNK_SIZE = 5;
  const results = [];

  const processItem = async (item) => {
    try {
      const config = getCategory(item.category);
      if (!config) return { id: item.id, error: 'Invalid category' };
      let mediaId = item.id;
      let title = item.title || '';
      if (mediaId.startsWith('franchise:')) {
        if (!title) return { id: item.id, error: 'Title required for franchise' };
        if (item.category === 'tokusatsu') {
          const media = await searchTmdbTvByTitle(title, item.category, logger);
          if (!media) return { id: item.id, error: 'Media not found' };
          mediaId = media.id;
          title = media.title;
        } else {
          const media = await searchShikimori(title);
          if (!media || media.length === 0) return { id: item.id, error: 'Media not found' };
          const normalized = normalizeShikimoriMedia(media[0], item.category);
          mediaId = normalized.id;
          title = normalized.title;
        }
      }
      let mediaObject = await getMediaObject(mediaId, item.category, title, logger);
      if (!mediaObject) {
        if (title) {
          mediaObject = await fallbackFetchAnimeByTitle(title, item.category, logger);
        }
        if (!mediaObject) return { id: item.id, error: 'Media object not found' };
      }
      const torrentResult = await searchReleasesWithFallback(mediaObject, false, logger);
      const rawReleases = torrentResult.releases;
      const ranked = rankReleases(mediaObject, rawReleases, null);
      const selected = selectBestCandidates(ranked, mediaObject, null);
      return {
        id: item.id,
        title: mediaObject.title,
        releases: selected.map(serializeRelease),
        total: selected.length,
        warnings: torrentResult.warnings,
        rateLimited: torrentResult.rateLimited
      };
    } catch (err) {
      logger.warn({ err, item }, 'Batch release item failed');
      return { id: item.id, error: err.message };
    }
  };

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const chunkPromises = chunk.map(item => processItem(item));
    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults);
  }

  res.json({ results });
}));

function generateCacheKey(bookmarks) {
  const sortedIds = bookmarks
    .map(b => b.id || b.mediaId || '')
    .filter(Boolean)
    .sort()
    .join(':');
  const hash = crypto.createHash('sha256').update(sortedIds).digest('hex');
  return `recommendations:v1:${hash}`;
}

router.post('/recommendations', validate(recommendationsSchema, 'body'), asyncHandler(async (req, res) => {
  const { logger } = req;
  const { bookmarks = [] } = req.body;

  if (!process.env.GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, recommendations disabled');
    return res.json({ items: [] });
  }

  if (bookmarks.length === 0) {
    return res.json({ items: [] });
  }

  const cacheKey = generateCacheKey(bookmarks);
  const cached = await getCache(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const bookmarkInfo = bookmarks.map(b => {
    const title = b.title || b.media?.title || 'Unknown';
    const genres = b.genres || b.media?.genres || [];
    const category = b.category || b.media?.category || 'anime';
    return `${title} (${category}${genres.length ? `, genres: ${genres.join(', ')}` : ''})`;
  }).join('\n');

  const prompt = `You are an expert in anime and tokusatsu recommendations. Based on the user's following bookmarks, suggest 6 similar titles they might enjoy.

Bookmarks:
${bookmarkInfo}

Return ONLY JSON in this shape:
{ "titles": ["Title 1", "Title 2", "Title 3", "Title 4", "Title 5", "Title 6"] }`;

  let titles = [];
  try {
    const response = await callGroq(prompt, logger);
    if (response && Array.isArray(response.titles)) {
      titles = response.titles.filter(t => typeof t === 'string' && t.length > 0 && t.length < 200);
    }
  } catch (err) {
    logger.error({ err }, 'Groq recommendation fetch failed');
    return res.json({ items: [] });
  }

  if (!titles.length) {
    return res.json({ items: [] });
  }

  const resolved = await Promise.all(titles.map(async (t) => {
    try {
      const shikimoriResults = await searchShikimori(t);
      if (shikimoriResults && shikimoriResults.length > 0) {
        const normalized = normalizeShikimoriMedia(shikimoriResults[0], 'anime');
        return mediaToCard(normalized);
      }
    } catch (err) {
      logger.warn({ err, title: t }, 'Shikimori resolution failed for recommendation');
    }
    return null;
  }));

  const items = resolved.filter(Boolean);
  const responseData = { items };

  await setCache(cacheKey, responseData, 86400);
  res.json(responseData);
}));

async function callGroq(prompt, logger) {
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
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new ApiError(res.status, `Groq API error: ${res.status}`, 'GROQ_API_ERROR');
  const data = await res.json();

  let content = data.choices?.[0]?.message?.content || '';
  content = content.replace(/```json\s*|\s*```/g, '').trim();

  try {
    return JSON.parse(content);
  } catch (e) {
    const match = content.match(/(\{.*\}|\[.*\])/s);
    if (match) {
      try { return JSON.parse(match[1]); } catch (_) {}
    }
    throw new Error('Invalid JSON from AI');
  }
}

module.exports = router;
