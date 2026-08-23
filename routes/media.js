const express = require('express');
const router = express.Router();
const { getCached, setCache } = require('../utils');
const { categoryConfig, CoverageType, TRUSTED_GROUPS } = require('../config');
const { fetchAniList, fetchTmdb, normalizeAniListMedia, normalizeJikanMedia, normalizeTmdbMedia, searchJikan } = require('../services/metadataService');
const { searchReleases } = require('../services/torrentService');
const { MediaType } = require('../config');

function getCategory(id) { return categoryConfig[id] || null; }

router.get('/releases', async (req, res) => {
  try {
    const mediaId = req.query.id || '';
    const categoryId = req.query.category || 'anime';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    if (!mediaId) return res.status(400).json({ error: 'Media ID required' });
    const config = getCategory(categoryId);
    if (!config) return res.status(400).json({ error: 'Invalid category' });
    const cacheKey = `releases:${mediaId}`;
    const cached = getCached(cacheKey);
    let mediaObject = null;
    let releases = [];
    if (cached) {
      releases = cached.releases || [];
      mediaObject = cached.media || null;
    } else {
      const provider = mediaId.startsWith('anilist') ? 'anilist' : 
                       mediaId.startsWith('jikan') ? 'jikan' : 'tmdb';
      const providerId = mediaId.split(':')[1];
      let rawMedia = null;
      let relations = [];

      if (provider === 'anilist') {
        const query = `
          query($id: Int) {
            Media(id: $id) {
              id title { romaji english native } synonyms seasonYear coverImage { medium large } format episodes chapters status genres
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
        `;
        const data = await fetchAniList(query, { id: parseInt(providerId) });
        rawMedia = data.Media;
        if (rawMedia && rawMedia.relations && rawMedia.relations.edges) {
          relations = rawMedia.relations.edges.map(e => ({
            id: e.node.id,
            title: e.node.title?.romaji || e.node.title?.english || e.node.title?.native || '',
            relationType: e.relationType,
            format: e.node.format
          }));
        }
        if (rawMedia) mediaObject = normalizeAniListMedia(rawMedia, categoryId, relations);
      } else if (provider === 'jikan') {
        const url = `https://api.jikan.moe/v4/anime/${providerId}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'KITO/1.0' },
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = await res.json();
          rawMedia = data.data;
          if (rawMedia) mediaObject = normalizeJikanMedia(rawMedia, categoryId);
        }
      } else if (provider === 'tmdb') {
        const mediaType = config.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
        const url = `https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${process.env.TMDB_API_KEY}&language=en-US`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          mediaObject = normalizeTmdbMedia(data, categoryId);
        }
      }

      if (mediaObject) {
        releases = await searchReleases(mediaObject);
        setCache(cacheKey, { media: mediaObject, releases });
      }
    }
    if (!mediaObject) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const high = releases.filter(r => r.confidence === 'high');
    const med = releases.filter(r => r.confidence === 'medium');
    const low = releases.filter(r => r.confidence === 'low');
    const total = releases.length;
    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);
    const paginated = releases.slice(start, end);
    const best = high.length > 0 ? high[0] : med.length > 0 ? med[0] : low.length > 0 ? low[0] : null;

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
      total,
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
      hasMore: end < total,
      lowConfidenceCount: low.length
    });
  } catch (err) {
    console.error('Releases error:', err);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

router.post('/recommendations', (req, res) => res.json({ items: [] }));

router.post('/ai-search', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Groq not configured' });
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const result = await callGroq(`Parse this user media search prompt into structured JSON filters: "${prompt}"`);
    res.json({ success: true, filters: result });
  } catch (err) {
    console.error('Groq error:', err);
    res.status(500).json({ error: 'AI parsing failed' });
  }
});

async function callGroq(prompt) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
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
  if (!res.ok) throw new Error(`Groq API error: ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

module.exports = router;
