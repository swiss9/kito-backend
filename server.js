const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TORRENTCLAW_API_KEY = process.env.TORRENTCLAW_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w300';
const ANILIST_API = 'https://graphql.anilist.co';

const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

const pending = new Map();

async function fetchWithDedup(key, fetchFn) {
  if (pending.has(key)) return pending.get(key);
  const promise = fetchFn().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

const categoryConfig = {
  anime: {
    id: 'anime',
    label: 'Anime',
    metadataProvider: 'anilist',
    mediaType: 'series',
    adapter: 'anime',
    torrentSources: ['torrentclaw', 'nyaa']
  },
  manga: {
    id: 'manga',
    label: 'Manga/Manhwa',
    metadataProvider: 'anilist',
    mediaType: 'manga',
    adapter: null,
    torrentSources: []
  },
  hollywood: {
    id: 'hollywood',
    label: 'Hollywood',
    metadataProvider: 'tmdb',
    mediaType: 'movie',
    adapter: 'movie',
    torrentSources: ['torrentclaw', 'yts']
  },
  bollywood: {
    id: 'bollywood',
    label: 'Bollywood',
    metadataProvider: 'tmdb',
    mediaType: 'movie',
    adapter: 'movie',
    torrentSources: ['torrentclaw', 'yts']
  },
  animation: {
    id: 'animation',
    label: 'Animation',
    metadataProvider: 'tmdb',
    mediaType: 'movie',
    adapter: 'movie',
    torrentSources: ['torrentclaw', 'yts']
  },
  asian: {
    id: 'asian',
    label: 'CN, KR & JP',
    metadataProvider: 'tmdb',
    mediaType: 'series',
    adapter: 'series',
    torrentSources: ['torrentclaw', 'eztv']
  },
  tokusatsu: {
    id: 'tokusatsu',
    label: 'Tokusatsu',
    metadataProvider: 'tmdb',
    mediaType: 'series',
    adapter: 'anime',
    torrentSources: ['torrentclaw', 'nyaa']
  }
};

function getCategory(id) {
  return categoryConfig[id] || null;
}

function normalizeAniListMedia(item, categoryId) {
  return {
    id: `anilist:${item.id}`,
    title: item.title?.romaji || item.title?.english || item.title?.native || 'Unknown',
    titles: {
      romaji: item.title?.romaji || '',
      english: item.title?.english || '',
      native: item.title?.native || ''
    },
    year: item.seasonYear || null,
    mediaType: item.format === 'MOVIE' ? 'movie' : 'series',
    episodes: item.episodes || null,
    chapters: item.chapters || null,
    status: item.status || 'UNKNOWN',
    poster: item.coverImage?.large || item.coverImage?.medium || '',
    genres: item.genres || [],
    provider: 'anilist',
    providerId: item.id,
    category: categoryId
  };
}

function normalizeTmdbMedia(item, categoryId) {
  const isMovie = item.media_type === 'movie' || item.release_date;
  return {
    id: `tmdb:${item.id}`,
    title: item.title || item.name || 'Unknown',
    titles: { english: item.title || item.name || '' },
    year: (item.release_date || item.first_air_date || '').substring(0, 4) || null,
    mediaType: isMovie ? 'movie' : 'series',
    episodes: null,
    chapters: null,
    status: item.status || 'UNKNOWN',
    poster: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '',
    genres: item.genre_ids || [],
    provider: 'tmdb',
    providerId: item.id,
    category: categoryId
  };
}

function getGradientClass(title) {
  const hash = title.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const classes = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'];
  return classes[hash % classes.length];
}

function mediaToCardArray(media) {
  const sub = media.mediaType === 'movie' ? `Film · ${media.year || 'Latest'}` :
              media.mediaType === 'manga' ? `Manga · ${media.year || 'Popular'}` :
              `Series · ${media.year || 'Latest'}`;
  return [media.title, sub, getGradientClass(media.title), Math.random() > 0.5, media.poster, media.id];
}

async function fetchAniList(query, variables) {
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

async function fetchTmdb(endpoint, params = {}) {
  if (!TMDB_API_KEY) return [];
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (let [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') url.searchParams.set(key, val);
  }
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function fetchTmdbList(listId, page = 1) {
  if (!TMDB_API_KEY) return [];
  const url = new URL(`https://api.themoviedb.org/3/list/${listId}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('page', page);
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || [];
}

async function searchTorrentClaw(title) {
  const baseUrl = 'https://torrentclaw.com/api/search';
  const params = new URLSearchParams({
    q: title,
    category: 'all',
    limit: 100,
  });
  if (TORRENTCLAW_API_KEY) params.append('apikey', TORRENTCLAW_API_KEY);
  const url = `${baseUrl}?${params.toString()}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`TorrentClaw: ${res.status}`);
  const data = await res.json();
  const results = data.results || data || [];
  return results.map(t => ({
    name: t.name || t.title || 'Unknown',
    magnet: t.magnet || t.magnetLink || '',
    size: t.size || '',
    seeders: t.seeders || 0,
    leechers: t.leechers || 0,
    uploader: t.uploader || t.uploaderName || t.username || ''
  }));
}

async function searchNyaa(title) {
  const searchUrl = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(title)}`;
  const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
  const html = await res.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const results = [];
  $('table.torrent-list tbody tr').each((i, row) => {
    if (i >= 75) return false;
    const tds = $(row).find('td');
    if (tds.length < 5) return;
    const name = $(tds[1]).find('a').last().text().trim();
    const magnet = $(tds[2]).find('a').attr('href');
    const size = $(tds[3]).text().trim();
    const seeders = parseInt($(tds[4]).text().trim()) || 0;
    const leechers = parseInt($(tds[5]).text().trim()) || 0;
    if (magnet && name) {
      results.push({ name, magnet, size, seeders, leechers, uploader: '' });
    }
  });
  return results;
}

async function searchYTS(title) {
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&limit=50`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) return [];
  const data = await res.json();
  if (data.status !== 'ok') return [];
  const movies = data.data.movies || [];
  return movies.map(m => ({
    name: m.title_long || m.title || 'Unknown',
    magnet: m.torrents && m.torrents.length > 0 ? m.torrents[0].url : '',
    size: m.torrents && m.torrents.length > 0 ? m.torrents[0].size : '',
    seeders: m.torrents && m.torrents.length > 0 ? m.torrents[0].seeds : 0,
    leechers: m.torrents && m.torrents.length > 0 ? m.torrents[0].peers : 0,
    uploader: 'YTS'
  }));
}

async function searchEZTV(title) {
  const url = `https://eztvx.to/api/get-torrents?query=${encodeURIComponent(title)}&limit=50`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    timeout: 8000
  });
  if (!res.ok) return [];
  const data = await res.json();
  const results = data.torrents || [];
  return results.map(t => ({
    name: t.title || 'Unknown',
    magnet: t.magnet_url || '',
    size: t.size || '',
    seeders: t.seeds || 0,
    leechers: t.leeches || 0,
    uploader: t.uploader || ''
  }));
}

function parseAnimeRelease(raw) {
  const name = raw.name || '';
  const lower = name.toLowerCase();
  let episodeStart = null;
  let episodeEnd = null;
  let isBatch = false;

  if (/batch|complete|全集|season pack|all episodes/i.test(lower)) {
    isBatch = true;
  }

  const rangePatterns = [
    /(\d+)\s*[-–]\s*(\d+)/,
    /[Ss](\d+)[Ee](\d+)\s*[-–]\s*[Ee]?(\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)\s*[-–]\s*(\d+)/i,
    /[Ee](\d+)\s*[-–]\s*[Ee]?(\d+)/
  ];

  for (let pat of rangePatterns) {
    const match = name.match(pat);
    if (match) {
      let start, end;
      if (match.length === 3) {
        start = parseInt(match[1]);
        end = parseInt(match[2]);
      } else if (match.length === 4) {
        start = parseInt(match[2]);
        end = parseInt(match[3]);
      } else {
        continue;
      }
      if (start > 0 && end > 0 && start < end) {
        episodeStart = start;
        episodeEnd = end;
        isBatch = true;
        break;
      }
    }
  }

  if (!episodeStart && !isBatch) {
    const cleanName = name.replace(/\[.*?\]|\(.*?\)/g, '')
      .replace(/\b(1080p|720p|2160p|480p|360p|4k|8k|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit)\b/gi, '');

    const epPatterns = [
      /[Ss](\d+)[Ee](\d+)/,
      /[Ee]p(?:isode)?\s*(\d+)/i,
      /[Ee](\d{2,4})(?:\s|$)/,
      /(?:^|\s)-?\s*(\d{1,4})\s*(?:$|\s)/,
      /[\(\[](\d{1,4})[\)\]]/
    ];

    for (let pat of epPatterns) {
      const match = cleanName.match(pat);
      if (match) {
        if (match.length === 3) {
          episodeStart = parseInt(match[2]);
        } else if (match.length === 2) {
          const num = parseInt(match[1]);
          if (!isNaN(num) && num > 0 && num < 10000) {
            episodeStart = num;
          }
        }
        break;
      }
    }
  }

  const qualityMatch = name.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  const quality = qualityMatch ? qualityMatch[1].toLowerCase() : 'unknown';

  const sourceMatch = name.match(/\b(WEB-DL|WEBRip|BluRay|DVD|HDTV)\b/i);
  const sourceType = sourceMatch ? sourceMatch[1].toLowerCase() : 'unknown';

  return {
    raw,
    name: raw.name,
    magnet: raw.magnet || '',
    size: raw.size || '',
    seeders: raw.seeders || 0,
    leechers: raw.leechers || 0,
    uploader: raw.uploader || '',
    episodeStart,
    episodeEnd,
    isBatch,
    quality,
    sourceType,
    normalizedTitle: name.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim()
  };
}

function parseMovieRelease(raw) {
  const name = raw.name || '';
  const qualityMatch = name.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  const quality = qualityMatch ? qualityMatch[1].toLowerCase() : 'unknown';
  const sourceMatch = name.match(/\b(WEB-DL|WEBRip|BluRay|DVD|HDTV)\b/i);
  const sourceType = sourceMatch ? sourceMatch[1].toLowerCase() : 'unknown';

  return {
    raw,
    name: raw.name,
    magnet: raw.magnet || '',
    size: raw.size || '',
    seeders: raw.seeders || 0,
    leechers: raw.leechers || 0,
    uploader: raw.uploader || '',
    isBatch: false,
    quality,
    sourceType,
    normalizedTitle: name.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim()
  };
}

function scoreAnimeRelease(release, media) {
  let score = 0;
  const titleMatch = release.name.toLowerCase().includes(media.title.toLowerCase());
  if (titleMatch) score += 100;
  if (media.episodes && release.episodeStart && release.episodeStart <= media.episodes) {
    score += 50;
  }
  if (release.isBatch) score += 60;
  if (release.quality === '1080p') score += 30;
  else if (release.quality === '2160p' || release.quality === '4k') score += 40;
  else if (release.quality === '720p') score += 20;
  if (release.sourceType === 'bluray') score += 30;
  else if (release.sourceType === 'web-dl') score += 20;
  if (release.seeders > 100) score += 30;
  else if (release.seeders > 50) score += 20;
  else if (release.seeders > 10) score += 10;
  if (!titleMatch) score -= 200;
  if (media.episodes && release.episodeStart && release.episodeStart > media.episodes + 10) {
    score -= 100;
  }
  return score;
}

function scoreMovieRelease(release, media) {
  let score = 0;
  const titleMatch = release.name.toLowerCase().includes(media.title.toLowerCase());
  if (titleMatch) score += 100;
  if (release.quality === '1080p') score += 30;
  else if (release.quality === '2160p' || release.quality === '4k') score += 40;
  else if (release.quality === '720p') score += 20;
  if (release.sourceType === 'bluray') score += 30;
  else if (release.sourceType === 'web-dl') score += 20;
  if (release.seeders > 100) score += 30;
  else if (release.seeders > 50) score += 20;
  else if (release.seeders > 10) score += 10;
  if (!titleMatch) score -= 200;
  return score;
}

function rankAnimeReleases(parsed, media) {
  const groups = {};
  parsed.forEach(p => {
    const key = p.normalizedTitle;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });
  const results = [];
  for (let key in groups) {
    const variants = groups[key];
    const scored = variants.map(v => ({ ...v, score: scoreAnimeRelease(v, media) }));
    scored.sort((a, b) => b.score - a.score);
    results.push(scored[0]);
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

function rankMovieReleases(parsed, media) {
  const groups = {};
  parsed.forEach(p => {
    const key = p.normalizedTitle;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });
  const results = [];
  for (let key in groups) {
    const variants = groups[key];
    const scored = variants.map(v => ({ ...v, score: scoreMovieRelease(v, media) }));
    scored.sort((a, b) => b.score - a.score);
    results.push(scored[0]);
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

async function searchAnimeReleases(media) {
  const queries = [media.title, `${media.title} batch`, `${media.title} complete`];
  if (media.titles?.english) {
    queries.push(`${media.titles.english} batch`);
  }
  if (media.titles?.native) {
    queries.push(`${media.titles.native} batch`);
  }
  const rawResults = [];
  const sources = ['torrentclaw', 'nyaa'];
  for (let src of sources) {
    try {
      let results = [];
      if (src === 'torrentclaw') {
        results = await searchTorrentClaw(queries.join(' '));
      } else if (src === 'nyaa') {
        for (let q of queries) {
          const r = await searchNyaa(q);
          if (r.length > 0) { results = r; break; }
        }
      }
      if (results.length > 0) {
        rawResults.push(...results);
        break;
      }
    } catch (err) {
      console.warn(`Source ${src} failed for ${media.title}:`, err.message);
    }
  }
  if (rawResults.length === 0) return [];
  const parsed = rawResults.map(r => parseAnimeRelease(r));
  const ranked = rankAnimeReleases(parsed, media);
  return ranked.slice(0, 20);
}

async function searchMovieReleases(media) {
  const queries = [media.title];
  const rawResults = [];
  const sources = ['torrentclaw', 'yts'];
  for (let src of sources) {
    try {
      let results = [];
      if (src === 'torrentclaw') {
        results = await searchTorrentClaw(queries.join(' '));
      } else if (src === 'yts') {
        results = await searchYTS(queries.join(' '));
      }
      if (results.length > 0) {
        rawResults.push(...results);
        break;
      }
    } catch (err) {
      console.warn(`Source ${src} failed for ${media.title}:`, err.message);
    }
  }
  if (rawResults.length === 0) return [];
  const parsed = rawResults.map(r => parseMovieRelease(r));
  const ranked = rankMovieReleases(parsed, media);
  return ranked.slice(0, 20);
}

async function searchReleases(media) {
  const category = getCategory(media.category);
  if (!category || !category.adapter) return [];
  if (category.adapter === 'anime' && category.mediaType === 'series') {
    return searchAnimeReleases(media);
  } else if (category.adapter === 'movie' && category.mediaType === 'movie') {
    return searchMovieReleases(media);
  } else if (category.adapter === 'series') {
    return searchAnimeReleases(media);
  }
  return [];
}

function filterReleasesByQuality(releases, quality) {
  if (!quality || quality === 'Any') return releases;
  return releases.filter(r => r.quality === quality.toLowerCase() || r.quality === quality);
}

app.get('/api/trending', async (req, res) => {
  try {
    const categoryId = req.query.category || 'anime';
    const page = parseInt(req.query.page) || 1;
    const config = getCategory(categoryId);
    if (!config) return res.status(400).json({ error: 'Invalid category' });

    let items = [];
    if (config.metadataProvider === 'anilist') {
      const query = `
        query($type: MediaType, $sort: [MediaSort], $page: Int) {
          Page(page: $page, perPage: 20) {
            media(type: $type, sort: $sort, status: RELEASING) {
              id title { romaji english native } seasonYear coverImage { medium large } format episodes chapters status genres
            }
          }
        }
      `;
      const type = config.mediaType === 'manga' ? 'MANGA' : 'ANIME';
      const variables = { type, sort: ['TRENDING_DESC', 'POPULARITY_DESC'], page };
      const data = await fetchAniList(query, variables);
      items = (data.Page.media || []).map(item => {
        const media = normalizeAniListMedia(item, categoryId);
        return mediaToCardArray(media);
      });
    } else if (config.metadataProvider === 'tmdb') {
      let mediaType = config.mediaType === 'movie' ? 'movie' : 'tv';
      let discoverParams = { sort_by: 'popularity.desc', page };
      if (categoryId === 'tokusatsu') {
        discoverParams.with_keywords = '317204';
      } else if (categoryId === 'hollywood') {
        discoverParams.region = 'US';
      } else if (categoryId === 'animation') {
        discoverParams.with_genres = '16';
      }
      const results = await fetchTmdb(`discover/${mediaType}`, discoverParams);
      items = results.map(item => {
        const media = normalizeTmdbMedia(item, categoryId);
        return mediaToCardArray(media);
      });
    }
    res.json({ category: categoryId, items });
  } catch (err) {
    console.error('Trending error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch trending' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const categoryId = req.query.category || 'any';
    if (!q) return res.json({ query: q, category: categoryId, items: [] });

    const categories = categoryId === 'any' ? Object.keys(categoryConfig) : [categoryId];
    let results = [];

    for (let catId of categories) {
      const config = getCategory(catId);
      if (!config) continue;

      if (config.metadataProvider === 'anilist') {
        const query = `
          query($search: String, $type: MediaType, $perPage: Int) {
            Page(page: 1, perPage: $perPage) {
              media(search: $search, type: $type) {
                id title { romaji english native } seasonYear coverImage { medium large } format episodes chapters status genres
              }
            }
          }
        `;
        const type = config.mediaType === 'manga' ? 'MANGA' : 'ANIME';
        const variables = { search: q, type, perPage: 5 };
        const data = await fetchAniList(query, variables);
        const items = (data.Page.media || []).map(item => {
          const media = normalizeAniListMedia(item, catId);
          return mediaToCardArray(media);
        });
        results.push(...items);
      } else if (config.metadataProvider === 'tmdb' && TMDB_API_KEY) {
        const mediaType = config.mediaType === 'movie' ? 'movie' : 'tv';
        const url = `https://api.themoviedb.org/3/search/${mediaType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const items = (data.results || []).slice(0, 5).map(item => {
            const media = normalizeTmdbMedia(item, catId);
            return mediaToCardArray(media);
          });
          results.push(...items);
        }
      }
    }

    const seen = new Set();
    const unique = results.filter(item => {
      const key = item[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json({ query: q, category: categoryId, items: unique.slice(0, 30) });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/releases', async (req, res) => {
  try {
    const mediaId = req.query.id || '';
    const categoryId = req.query.category || 'anime';
    const quality = req.query.quality || 'Any';
    const source = req.query.source || 'auto';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!mediaId) return res.status(400).json({ error: 'Media ID required' });

    const config = getCategory(categoryId);
    if (!config) return res.status(400).json({ error: 'Invalid category' });

    if (categoryId === 'manga') {
      return res.json({
        mediaId,
        category: categoryId,
        total: 0,
        page,
        limit,
        torrents: [],
        hasMore: false,
        message: 'Manga are not available for download. Please check official sources.'
      });
    }

    const cacheKey = `releases:${mediaId}:${source}`;
    const cached = getCached(cacheKey);
    let mediaObject = null;
    let releases = [];

    if (cached) {
      releases = cached.releases || [];
      mediaObject = cached.media || null;
    } else {
      const provider = mediaId.startsWith('anilist') ? 'anilist' : 'tmdb';
      const providerId = mediaId.split(':')[1];
      let rawMedia = null;

      if (provider === 'anilist') {
        const query = `
          query($id: Int) {
            Media(id: $id) {
              id title { romaji english native } seasonYear coverImage { medium large } format episodes chapters status genres
            }
          }
        `;
        const data = await fetchAniList(query, { id: parseInt(providerId) });
        rawMedia = data.Media;
        if (rawMedia) {
          mediaObject = normalizeAniListMedia(rawMedia, categoryId);
        }
      } else if (provider === 'tmdb') {
        const mediaType = config.mediaType === 'movie' ? 'movie' : 'tv';
        const url = `https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const res = await fetch(url);
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

    let filtered = releases;
    if (quality && quality !== 'Any') {
      filtered = filterReleasesByQuality(releases, quality);
    }

    const total = filtered.length;
    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);
    const paginated = filtered.slice(start, end);

    res.json({
      mediaId,
      category: categoryId,
      media: {
        title: mediaObject.title,
        poster: mediaObject.poster,
        year: mediaObject.year,
        mediaType: mediaObject.mediaType,
        episodes: mediaObject.episodes
      },
      total,
      page,
      limit,
      torrents: paginated.map(r => ({
        name: r.name,
        magnet: r.magnet,
        size: r.size,
        seeders: r.seeders,
        leechers: r.leechers,
        uploader: r.uploader,
        type: r.isBatch ? 'batch' : 'single',
        quality: r.quality,
        description: r.episodeStart ? `Episode ${r.episodeStart} · Size: ${r.size}` : `Size: ${r.size}`
      })),
      hasMore: end < total
    });
  } catch (err) {
    console.error('Releases error:', err);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

app.post('/api/ai-search', async (req, res) => {
  if (!GROQ_API_KEY) return res.status(503).json({ error: 'Groq not configured' });
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
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
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

app.get('/', (req, res) => res.send('KITO API running.'));
app.listen(PORT, () => console.log(`KITO backend on port ${PORT}`));