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
const { categoryConfig, TRUSTED_GROUPS, MediaType } = require('../config');
const { fetchTmdb, searchKitsu, searchShikimori, fetchShikimori, normalizeKitsuMedia, normalizeTmdbMedia, normalizeShikimoriMedia, mediaToCard } = require('../services/metadataService');
const { searchReleasesWithFallback } = require('../services/torrentService');
const { rankReleases, selectBestCandidates } = require('../services/releaseRankingService');
const { isValidAdminToken } = require('../utils');
const redisClient = require('../services/redisClient');
const logger = require('../services/logger');

const TOKUSATSU_KEYWORD_ID = '317204';
const TMDB_DETAIL_TTL = 86400;
const TMDB_NOT_FOUND_TTL = 60;
const GROQ_TIMEOUT_MS = 6000;
const MAX_BOOKMARKS_TO_ENRICH = 5;
const MAX_TITLES_TO_RESOLVE = 6;
const ENRICHMENT_WALL_CLOCK_MS = 2000;
const EMPTY_REC_TTL_SECONDS = 300;

const RECOMMENDATION_SYSTEM_PROMPT = 'You are an anime and tokusatsu recommendation engine. Based on user bookmarks, suggest similar titles. Return only valid JSON.';

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

function serializeRelease(r) {
  let description = 'Unknown coverage';
  const type = r.coverageType;

  if (type === 'complete_season' || type === 'complete_series') {
    description = 'Complete series';
  } else if (type === 'partial_batch' || type === 'episode_range') {
    description = `Episodes ${r.episodeStart}-${r.episodeEnd} (${r.coveragePercent || 0}%)`;
  } else if (type === 'single') {
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

async function fetchTmdbCached(url, cacheKey) {
  const cached = await getCache(cacheKey);
  if (cached && cached.__notFound) return null;
  if (cached) return cached;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(4000),
    headers: { 'User-Agent': 'KITO/1.0' }
  });
  if (!res.ok) {
    await setCache(cacheKey, { __notFound: true }, TMDB_NOT_FOUND_TTL);
    return null;
  }
  const data = await res.json();
  await setCache(cacheKey, data, TMDB_DETAIL_TTL);
  return data;
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

async function fetchTmdbWithTypeFallback(providerId, initialMediaType) {
  const apiKey = process.env.TMDB_API_KEY;
  let mediaType = initialMediaType;

  const initialUrl = `https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${apiKey}&language=en-US`;
  const initialCacheKey = `tmdb:detail:${mediaType}:${providerId}`;
  let detailData = await fetchTmdbCached(initialUrl, initialCacheKey);

  if (!detailData && mediaType === 'tv') {
    mediaType = 'movie';
    const movieUrl = `https://api.themoviedb.org/3/movie/${providerId}?api_key=${apiKey}&language=en-US`;
    const movieCacheKey = `tmdb:detail:movie:${providerId}`;
    detailData = await fetchTmdbCached(movieUrl, movieCacheKey);
  }

  if (!detailData) throw new Error(`TMDB detail not found for ${providerId}`);

  const keywordUrl = `https://api.themoviedb.org/3/${mediaType}/${providerId}/keywords?api_key=${apiKey}`;
  const keywordCacheKey = `tmdb:keywords:${mediaType}:${providerId}`;
  const keywordData = await fetchTmdbCached(keywordUrl, keywordCacheKey);
  const keywords = keywordData ? (keywordData.keywords || keywordData.results || []) : [];

  return { data: detailData, mediaType, keywords };
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
    const shikimoriResults = await searchShikimori(title, 1);
    if (shikimoriResults && shikimoriResults.length > 0) {
      return normalizeShikimoriMedia(shikimoriResults[0], categoryId);
    }
  } catch (err) {
    logger.warn({ err, title }, 'Shikimori fallback failed');
  }

  try {
    const kitsuResults = await searchKitsu(title, 1);
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
  const detectedProvider = mediaId.startsWith('shikimori') ? 'shikimori' : 'tmdb';
  const providerId = mediaId.split(':')[1];

  if (categoryId === 'tokusatsu' && detectedProvider !== 'tmdb') {
    if (!title) {
      logger.warn({ mediaId }, 'Tokusatsu non-TMDB ID without title, cannot resolve');
      return null;
    }
    logger.info({ mediaId, title, detectedProvider }, 'Tokusatsu category - forcing TMDB title resolution');
    const tmdbMedia = await searchTmdbTvByTitle(title, categoryId, logger);
    if (tmdbMedia) return tmdbMedia;
    return null;
  }

  const provider = detectedProvider;

  if (provider === 'shikimori') {
    try {
      const data = await fetchShikimori(`https://shikimori.one/api/animes/${providerId}`);
      return normalizeShikimoriMedia(data, categoryId);
    } catch (err) {
      logger.warn({ err, provider: 'shikimori', id: providerId }, 'Shikimori detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId, logger);
      return null;
    }
  }

  if (provider === 'tmdb') {
    if (!process.env.TMDB_API_KEY) throw new ApiError(503, 'TMDB API key not configured', 'TMDB_KEY_MISSING');
    try {
      const config = getCategory(categoryId);
      const initialMediaType = config.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
      const { data, keywords } = await fetchTmdbWithTypeFallback(providerId, initialMediaType);

      const isTokusatsu = keywords.some(k => k.id === parseInt(TOKUSATSU_KEYWORD_ID));

      let resolvedCategory = categoryId;
      if (isTokusatsu && categoryId === 'anime') {
        resolvedCategory = 'tokusatsu';
      }
      return normalizeTmdbMedia(data, resolvedCategory);
    } catch (err) {
      logger.warn({ err, provider: 'tmdb', id: providerId }, 'TMDB detail failed');
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId, logger);
      return null;
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
      const media = await searchShikimori(title, 1);
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
          const media = await searchShikimori(title, 1);
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

const GENERIC_TITLE_VALUES = new Set([
  'unknown',
  'unknown title',
  'n/a',
  'na',
  'tba',
  'untitled'
]);

function isGenericTitle(title) {
  if (!title) return true;
  const trimmed = title.trim();
  if (trimmed.length < 3) return true;
  if (GENERIC_TITLE_VALUES.has(trimmed.toLowerCase())) return true;
  return false;
}

async function enrichBookmark(bookmark, logger) {
  const id = bookmark.mediaId || bookmark.id || '';
  const category = bookmark.category || bookmark.media?.category || 'anime';
  const fallbackTitle = bookmark.title || bookmark.media?.title || 'Unknown';

  if (!isGenericTitle(fallbackTitle)) {
    return { title: fallbackTitle, category };
  }

  if (!id) {
    return null;
  }

  try {
    const mediaObject = await getMediaObject(id, category, '', logger);
    if (mediaObject && mediaObject.title && !isGenericTitle(mediaObject.title)) {
      return { title: mediaObject.title, category: mediaObject.category || category };
    }
  } catch (err) {
    logger.warn({ err, id }, 'Bookmark enrichment failed');
  }
  return null;
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

  const bookmarksToEnrich = bookmarks.slice(0, MAX_BOOKMARKS_TO_ENRICH);
  const enrichmentPromise = Promise.all(
    bookmarksToEnrich.map(b => enrichBookmark(b, logger))
  );

  let timer;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve([]), ENRICHMENT_WALL_CLOCK_MS);
  });

  const enrichedRaw = await Promise.race([enrichmentPromise, timeoutPromise]);
  clearTimeout(timer);

  const enriched = Array.isArray(enrichedRaw) ? enrichedRaw.filter(Boolean) : [];

  if (enriched.length === 0) {
    logger.warn({ bookmarkCount: bookmarks.length }, 'No usable bookmark titles for recommendation');
    await setCache(cacheKey, { items: [] }, EMPTY_REC_TTL_SECONDS);
    return res.json({ items: [] });
  }

  const bookmarkInfo = enriched
    .map(e => `${e.title} (${e.category})`)
    .join('\n');

  const prompt = `Based on the user's following bookmarks, suggest 6 similar titles they might enjoy.

Bookmarks:
${bookmarkInfo}

Return ONLY JSON in this shape:
{ "titles": ["Title 1", "Title 2", "Title 3", "Title 4", "Title 5", "Title 6"] }`;

  let titles = [];
  try {
    const response = await callGroq(RECOMMENDATION_SYSTEM_PROMPT, prompt, logger);
    if (response && Array.isArray(response.titles)) {
      titles = response.titles
        .filter(t => typeof t === 'string' && t.length > 0 && t.length < 200)
        .slice(0, MAX_TITLES_TO_RESOLVE);
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
      const shikimoriResults = await searchShikimori(t, 1);
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

async function callGroq(systemPrompt, userPrompt, logger) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS)
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
