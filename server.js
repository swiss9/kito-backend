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

async function fetchTmdbPoster(title) {
  if (!TMDB_API_KEY) return null;
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.results?.[0];
  if (item && item.poster_path) {
    return `${TMDB_IMAGE_BASE}${item.poster_path}`;
  }
  return null;
}

async function fetchAniListPoster(title) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 1) {
        media(search: $search) {
          coverImage { large }
        }
      }
    }
  `;
  try {
    const res = await fetch(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { search: title } })
    });
    const data = await res.json();
    const item = data.data?.Page?.media?.[0];
    if (item && item.coverImage?.large) {
      return item.coverImage.large;
    }
  } catch (err) {}
  return null;
}

async function getPoster(title) {
  let poster = await fetchAniListPoster(title);
  if (!poster) poster = await fetchTmdbPoster(title);
  return poster || '';
}

function getGradientClass(title) {
  const hash = title.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const classes = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'];
  return classes[hash % classes.length];
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
    normalizedTitle: name.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim()
  };
}

function parseMovieRelease(raw) {
  const name = raw.name || '';
  const qualityMatch = name.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  const quality = qualityMatch ? qualityMatch[1].toLowerCase() : 'unknown';

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
    normalizedTitle: name.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim()
  };
}

function rankAnimeReleases(parsed) {
  const groups = {};
  parsed.forEach(p => {
    if (p.isBatch) {
      const key = 'batch_' + p.normalizedTitle;
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    } else if (p.episodeStart !== null) {
      const key = 'ep_' + p.episodeStart;
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    } else {
      const key = 'other_' + p.normalizedTitle;
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }
  });

  const results = [];
  for (let key in groups) {
    const variants = groups[key];
    const sorted = variants.sort((a, b) => {
      if (a.seeders !== b.seeders) return b.seeders - a.seeders;
      return parseSize(b.size) - parseSize(a.size);
    });
    results.push(sorted[0]);
  }

  results.sort((a, b) => {
    if (a.isBatch && !b.isBatch) return -1;
    if (!a.isBatch && b.isBatch) return 1;
    if (a.episodeStart !== null && b.episodeStart !== null) return a.episodeStart - b.episodeStart;
    return b.seeders - a.seeders;
  });

  return results;
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/([\d.]+)\s*([KMG]B?)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit.startsWith('K')) return val * 1024;
  if (unit.startsWith('M')) return val * 1024 * 1024;
  if (unit.startsWith('G')) return val * 1024 * 1024 * 1024;
  return 0;
}

function rankMovieReleases(parsed) {
  const groups = {};
  parsed.forEach(p => {
    const key = p.normalizedTitle;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  const results = [];
  for (let key in groups) {
    const variants = groups[key];
    const sorted = variants.sort((a, b) => {
      if (a.seeders !== b.seeders) return b.seeders - a.seeders;
      return parseSize(b.size) - parseSize(a.size);
    });
    results.push(sorted[0]);
  }

  results.sort((a, b) => {
    if (a.quality === '1080p' && b.quality !== '1080p') return -1;
    if (a.quality === '2160p' && b.quality !== '2160p') return -1;
    return b.seeders - a.seeders;
  });

  return results;
}

async function searchTorrents(title, isMovie = false) {
  const cacheKey = `torrents:${title}:${isMovie}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let rawResults = [];
  let usedSource = '';

  if (isMovie) {
    const sources = ['torrentclaw', 'yts'];
    for (let src of sources) {
      try {
        let results = [];
        if (src === 'torrentclaw') {
          results = await searchTorrentClaw(title);
          usedSource = 'torrentclaw';
        } else if (src === 'yts') {
          results = await searchYTS(title);
          usedSource = 'yts';
        }
        if (results.length > 0) {
          rawResults = results;
          break;
        }
      } catch (err) {
        console.warn(`Movie source ${src} failed:`, err.message);
      }
    }
  } else {
    const queries = [title, `${title} batch`, `${title} complete`];
    const sources = ['torrentclaw', 'nyaa', 'eztv'];
    for (let src of sources) {
      try {
        let results = [];
        if (src === 'torrentclaw') {
          results = await searchTorrentClaw(queries.join(' '));
          usedSource = 'torrentclaw';
        } else if (src === 'nyaa') {
          for (let q of queries) {
            const r = await searchNyaa(q);
            if (r.length > 0) { results = r; break; }
          }
          usedSource = 'nyaa';
        } else if (src === 'eztv') {
          results = await searchEZTV(queries.join(' '));
          usedSource = 'eztv';
        }
        if (results.length > 0) {
          rawResults = results;
          break;
        }
      } catch (err) {
        console.warn(`Series source ${src} failed:`, err.message);
      }
    }
  }

  if (rawResults.length === 0) {
    const empty = { results: [], source: 'none' };
    setCache(cacheKey, empty);
    return empty;
  }

  let parsed, ranked;
  if (isMovie) {
    parsed = rawResults.map(r => parseMovieRelease(r));
    ranked = rankMovieReleases(parsed);
  } else {
    parsed = rawResults.map(r => parseAnimeRelease(r));
    ranked = rankAnimeReleases(parsed);
  }

  const result = { results: ranked, source: usedSource };
  setCache(cacheKey, result);
  return result;
}

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    if (!q) return res.json({ query: q, items: [] });

    const cacheKey = `search:${q}`;
    let allResults = getCached(cacheKey);

    if (!allResults) {
      const isMovie = false; // default to series search, but we'll check both
      const seriesResults = await searchTorrents(q, false);
      const movieResults = await searchTorrents(q, true);

      const combined = [...seriesResults.results, ...movieResults.results];
      const seen = new Set();
      const unique = [];
      for (let item of combined) {
        const key = item.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(item);
        }
      }
      allResults = unique;
      setCache(cacheKey, allResults);
    }

    const start = (page - 1) * limit;
    const end = Math.min(start + limit, allResults.length);
    const paginated = allResults.slice(start, end);

    // Enrich with posters
    const enriched = await Promise.all(paginated.map(async (item) => {
      const poster = await getPoster(item.name);
      const cls = getGradientClass(item.name);
      const sub = `Torrent · ${item.seeders || 0} seeders`;
      return [item.name, sub, cls, item.isBatch || false, poster];
    }));

    res.json({
      query: q,
      items: enriched,
      total: allResults.length,
      page,
      limit,
      hasMore: end < allResults.length
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/releases', async (req, res) => {
  try {
    const title = req.query.title || '';
    const quality = req.query.quality || 'Any';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!title) return res.status(400).json({ error: 'Title required' });

    const result = await searchTorrents(title, false);
    let filtered = result.results;
    if (quality && quality !== 'Any') {
      filtered = filtered.filter(r => r.quality === quality.toLowerCase() || r.quality === quality);
    }

    const total = filtered.length;
    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);
    const paginated = filtered.slice(start, end);

    res.json({
      title,
      source: result.source,
      total,
      page,
      limit,
      torrents: paginated.map(r => ({
        name: r.name,
        magnet: r.magnet,
        size: r.size,
        seeders: r.seeders,
        leechers: r.leechers,
        uploader: r.uploader || '',
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

app.post('/api/recommendations', async (req, res) => {
  try {
    const { bookmarks } = req.body;
    if (!bookmarks || !Array.isArray(bookmarks) || bookmarks.length === 0) {
      return res.json({ items: [] });
    }
    const titles = bookmarks.slice(0, 5).map(b => b.title).filter(Boolean);
    const results = [];
    for (let title of titles) {
      if (title) {
        const torrents = await searchTorrents(title, false);
        const top = torrents.results.slice(0, 2);
        for (let t of top) {
          const poster = await getPoster(t.name);
          const cls = getGradientClass(t.name);
          results.push([t.name, `Recommendation · ${t.seeders || 0} seeders`, cls, t.isBatch || false, poster]);
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
    res.json({ items: unique.slice(0, 8) });
  } catch (err) {
    console.error('Recommendations error:', err);
    res.status(500).json({ error: 'Failed to get recommendations' });
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