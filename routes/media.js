const express = require('express');
const router = express.Router();
const Joi = require('joi');
const crypto = require('crypto');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ApiError } = require('../middleware/errorHandler');
const { getCache, setCache } = require('../services/cacheService');
const { categoryConfig, CoverageType, TRUSTED_GROUPS, MediaType } = require('../config');
const { fetchAniList, searchAnilistByTitle, fetchTmdb, searchJikan, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia, mediaToCard } = require('../services/metadataService');
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

function extractEpisodeNumberFallback(name) {
  const patterns = [
    /[Ee](\d{2,3})(?![0-9])/,
    /[Ee]p(?:isode)?\s*(\d+)/i,
    /EP\s*(\d+)/i,
    /#(\d+)/
  ];
  for (const pat of patterns) {
    const match = name.match(pat);
    if (match) {
      const num = parseInt(match[1]);
      if (num > 0 && num < 1000) return num;
    }
  }
  return null;
}

async function fallbackFetchAnimeByTitle(title, categoryId, logger) {
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

async function getMediaObject(mediaId, categoryId, title, logger) {
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
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId, logger);
      if (process.env.TMDB_API_KEY) {
        try {
          const tmdbRes = await fetchTmdb(`find/${providerId}`, { external_source: 'tvdb_id' });
          if (tmdbRes.length) {
            const tmdbItem = tmdbRes[0];
            const tokusatsuCategory = 'tokusatsu';
            const media = normalizeTmdbMedia(tmdbItem, tokusatsuCategory);
            if (media) return media;
          }
        } catch (e) {
          logger.warn({ err: e, mediaId }, 'TMDB fallback for AniList ID failed');
        }
      }
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
      if (title) return await fallbackFetchAnimeByTitle(title, categoryId, logger);
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

  if (!mediaId) {
    throw new ApiError(400, 'Media ID required', 'MEDIA_ID_REQUIRED');
  }

  let mediaObject = null;
  let releases = [];
  let resolvedCategory = categoryId;

  const cacheKey = `releases:${resolvedCategory}:${mediaId}`;
  const cacheKeyWithForce = force ? `${cacheKey}:force:${Date.now()}` : `${cacheKey}:force:false`;

  if (!force) {
    const cached = await getCache(cacheKeyWithForce);
    if (cached) {
      mediaObject = cached.media;
      releases = cached.releases;
      return res.json({
        mediaId,
        category: resolvedCategory,
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

  mediaObject = await getMediaObject(mediaId, categoryId, title, logger);
  if (!mediaObject) {
    if (mediaId.startsWith('anilist:')) {
      const providerId = mediaId.split(':')[1];
      if (process.env.TMDB_API_KEY) {
        try {
          const tmdbRes = await fetchTmdb(`find/${providerId}`, { external_source: 'tvdb_id' });
          if (tmdbRes.length) {
            const tmdbItem = tmdbRes[0];
            const tokusatsuCategory = 'tokusatsu';
            const media = normalizeTmdbMedia(tmdbItem, tokusatsuCategory);
            if (media) {
              mediaObject = media;
              resolvedCategory = tokusatsuCategory;
              logger.info({ mediaId, resolvedCategory }, 'Fell back to TMDB for AniList ID');
            }
          }
        } catch (e) {
          logger.warn({ err: e, mediaId }, 'TMDB fallback for AniList ID failed');
        }
      }
    }
    if (!mediaObject) throw new ApiError(404, 'Media not found', 'MEDIA_NOT_FOUND');
  }

  releases = await searchReleasesWithFallback(mediaObject, force, logger);

  const singleEpisodes = releases.filter(r => {
    if (r.coverageType === CoverageType.SINGLE && r.episodeStart !== null) return true;
    if (r.coverageType !== CoverageType.SINGLE && r.episodeStart === null) {
      const ep = extractEpisodeNumberFallback(r.name);
      if (ep !== null) {
        r.episodeStart = ep;
        r.coverageType = CoverageType.SINGLE;
        return true;
      }
    }
    return false;
  });
  const nonSingles = releases.filter(r => !(r.coverageType === CoverageType.SINGLE && r.episodeStart !== null));
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
    category: resolvedCategory,
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
        const media = await searchAnilistByTitle(title);
        if (!media) return { id: item.id, error: 'Media not found' };
        mediaId = `anilist:${media.id}`;
        title = media.title?.romaji || media.title?.english || title;
      }
      const mediaObject = await getMediaObject(mediaId, item.category, title, logger);
      if (!mediaObject) {
        if (mediaId.startsWith('anilist:')) {
          const providerId = mediaId.split(':')[1];
          if (process.env.TMDB_API_KEY) {
            try {
              const tmdbRes = await fetchTmdb(`find/${providerId}`, { external_source: 'tvdb_id' });
              if (tmdbRes.length) {
                const tmdbItem = tmdbRes[0];
                const tokusatsuCategory = 'tokusatsu';
                const media = normalizeTmdbMedia(tmdbItem, tokusatsuCategory);
                if (media) {
                  mediaObject = media;
                  item.category = tokusatsuCategory;
                }
              }
            } catch (e) {
              logger.warn({ err: e, mediaId }, 'TMDB fallback for AniList ID failed');
            }
          }
        }
        if (!mediaObject) return { id: item.id, error: 'Media object not found' };
      }
      let releases = await searchReleasesWithFallback(mediaObject, false, logger);

      const singles = releases.filter(r => {
        if (r.coverageType === CoverageType.SINGLE && r.episodeStart !== null) return true;
        if (r.coverageType !== CoverageType.SINGLE && r.episodeStart === null) {
          const ep = extractEpisodeNumberFallback(r.name);
          if (ep !== null) {
            r.episodeStart = ep;
            r.coverageType = CoverageType.SINGLE;
            return true;
          }
        }
        return false;
      });
      const nonSingles = releases.filter(r => !(r.coverageType === CoverageType.SINGLE && r.episodeStart !== null));
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

async function fetchRecommendationsFromGroq(bookmarks, logger) {
  const bookmarkInfo = bookmarks.map(b => {
    const title = b.title || b.media?.title || 'Unknown';
    const genres = b.genres || b.media?.genres || [];
    const category = b.category || b.media?.category || 'anime';
    return `${title} (${category}${genres.length ? `, genres: ${genres.join(', ')}` : ''})`;
  }).join('\n');

  const prompt = `You are an expert in anime and tokusatsu recommendations. Based on the user's following bookmarks, suggest 6 similar titles they might enjoy.

Bookmarks:
${bookmarkInfo}

Return ONLY a JSON array of AniList IDs (integers). Do not include any other text, explanation, or formatting. Example: [12345, 67890, 11111, 22222, 33333, 44444]`;

  try {
    const response = await callGroq(prompt, logger);
    let ids = [];
    try {
      const cleaned = response.replace(/```json\s*|\s*```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        ids = parsed.filter(id => Number.isInteger(id) && id > 0);
      }
    } catch (_) {
      const match = response.match(/\[[\s\d,.]+\]/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            ids = parsed.filter(id => Number.isInteger(id) && id > 0);
          }
        } catch (__) {}
      }
    }
    return ids;
  } catch (err) {
    logger.error({ err }, 'Groq recommendation fetch failed');
    return [];
  }
}

async function fetchAniListMediaByIds(ids, logger) {
  if (!ids.length) return [];
  const query = `
    query($ids: [Int]) {
      Page(page: 1, perPage: 50) {
        media(id_in: $ids, type: ANIME) {
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
        }
      }
    }
  `;
  try {
    const data = await fetchAniList(query, { ids });
    if (!data.Page || !data.Page.media) return [];
    return data.Page.media;
  } catch (err) {
    logger.error({ err, ids }, 'Failed to fetch AniList media by IDs');
    return [];
  }
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
    logger.info({ cacheKey }, 'Recommendations cache hit');
    return res.json(cached);
  }

  logger.info({ cacheKey, count: bookmarks.length }, 'Recommendations cache miss, fetching from Groq');

  const recommendedIds = await fetchRecommendationsFromGroq(bookmarks, logger);

  if (!recommendedIds.length) {
    return res.json({ items: [] });
  }

  const rawMedia = await fetchAniListMediaByIds(recommendedIds, logger);
  if (!rawMedia.length) {
    return res.json({ items: [] });
  }

  const items = rawMedia.map(item => {
    const normalized = normalizeAniListMedia(item, 'anime', []);
    return mediaToCard(normalized);
  }).filter(Boolean);

  const responseData = { items };

  await setCache(cacheKey, responseData, 86400);

  res.json(responseData);
}));

function getAISearchCacheKey(prompt) {
  const normalized = prompt.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `ai-search:v1:${hash}`;
}

router.post('/ai-search', validate(aiSearchSchema, 'body'), asyncHandler(async (req, res) => {
  const { logger } = req;
  if (!process.env.GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, AI search disabled');
    throw new ApiError(503, 'Groq not configured', 'GROQ_NOT_CONFIGURED');
  }

  const { prompt } = req.body;

  const cacheKey = getAISearchCacheKey(prompt);
  const cached = await getCache(cacheKey);
  if (cached) {
    logger.info({ cacheKey }, 'AI search cache hit');
    return res.json(cached);
  }

  logger.info({ cacheKey }, 'AI search cache miss, calling Groq');
  const result = await callGroq(`Parse this user media search prompt into structured JSON filters: "${prompt}"`, logger);
  const responseData = { success: true, filters: result };

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
    })
  });
  if (!res.ok) throw new ApiError(res.status, `Groq API error: ${res.status}`, 'GROQ_API_ERROR');
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

module.exports = router;