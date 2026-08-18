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

async function fetchTorrentClaw(title) {
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

async function scrapeNyaa(title) {
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

async function fetchYTS(title) {
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

async function fetchEZTV(title) {
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

let torrentSearchApi = null;
try {
  const TSA = require('torrent-search-api');
  torrentSearchApi = TSA;
  torrentSearchApi.enableProvider('ThePirateBay');
  torrentSearchApi.enableProvider('1337x');
  torrentSearchApi.enableProvider('RARBG');
  torrentSearchApi.enableProvider('Torrentz2');
} catch (err) {
  console.warn('torrent-search-api not installed, skipping');
}

async function fetchTorrentSearchApi(title) {
  if (!torrentSearchApi) return [];
  try {
    const results = await torrentSearchApi.search(title, 'All', 50);
    return results.map(t => ({
      name: t.title || 'Unknown',
      magnet: t.magnet || t.torrent || '',
      size: t.size || '',
      seeders: t.seeds || 0,
      leechers: t.peers || 0,
      uploader: t.provider || ''
    }));
  } catch (err) {
    console.warn('torrent-search-api error:', err.message);
    return [];
  }
}

async function getTorrents(title, category, source = 'auto', episode = null) {
  const cacheKey = `torrents:${source}:${category}:${title.toLowerCase()}:${episode || ''}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const fetchFn = async () => {
    let torrents = [];
    let usedSource = source;
    let fallbackChain = [];

    const animeLike = ['Anime', 'Manga', 'Tokusatsu'];
    const movieLike = ['Hollywood', 'Bollywood', 'Animation', 'Asian'];

    if (animeLike.includes(category)) {
      fallbackChain = ['torrentclaw', 'nyaa'];
    } else if (movieLike.includes(category)) {
      fallbackChain = ['torrentclaw', 'yts', 'eztv', 'torrentsearchapi'];
    } else {
      fallbackChain = ['torrentclaw', 'yts', 'eztv', 'torrentsearchapi'];
    }

    if (source !== 'auto') {
      fallbackChain = [source];
    }

    for (let src of fallbackChain) {
      try {
        if (src === 'torrentclaw') {
          torrents = await fetchTorrentClaw(title);
          usedSource = 'torrentclaw';
        } else if (src === 'nyaa') {
          torrents = await scrapeNyaa(title);
          usedSource = 'nyaa';
        } else if (src === 'yts') {
          torrents = await fetchYTS(title);
          usedSource = 'yts';
        } else if (src === 'eztv') {
          torrents = await fetchEZTV(title);
          usedSource = 'eztv';
        } else if (src === 'torrentsearchapi') {
          torrents = await fetchTorrentSearchApi(title);
          usedSource = 'torrentsearchapi';
        }
        if (torrents.length > 0) break;
      } catch (err) {
        console.warn(`Source ${src} failed for ${title}:`, err.message);
        continue;
      }
    }

    const best = filterBestTorrents(torrents);
    const result = { results: best, source: usedSource || 'none' };
    setCache(cacheKey, result);
    return result;
  };

  return fetchWithDedup(cacheKey, fetchFn);
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

function filterByQualitySource(torrents, quality, source) {
  if (!torrents || torrents.length === 0) return [];
  return torrents.filter(t => {
    const name = t.name.toUpperCase();
    if (quality && quality !== 'Any') {
      if (!name.includes(quality.toUpperCase())) return false;
    }
    if (source && source !== 'Any') {
      const srcClean = source.replace(/[^a-zA-Z]/g, '').toUpperCase();
      if (!name.includes(srcClean)) return false;
    }
    return true;
  });
}

function filterBestTorrents(torrents) {
  if (!torrents || torrents.length === 0) return [];

  function stripResolutions(name) {
    return name.replace(/\b(1080p|720p|2160p|480p|360p|4k|8k|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit|Dual Audio|Multi Sub|Multi-Subs|Dual-Audio|VOSTFR|SUBFRENCH|READNFO)\b/gi, '').trim();
  }

  function extractEpisodeInfo(name) {
    let episode = null;
    let episodeRange = null;
    let isBatch = false;

    if (/batch|complete|全集|season pack|all episodes/i.test(name)) {
      isBatch = true;
    }

    const rangePatterns = [
      /(\d+)\s*[-–]\s*(\d+)/,
      /[Ss](\d+)[Ee](\d+)\s*[-–]\s*[Ee]?(\d+)/,
      /[Ee]p(?:isode)?\s*(\d+)\s*[-–]\s*(\d+)/i,
      /[Ee](\d+)\s*[-–]\s*[Ee]?(\d+)/,
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
          episodeRange = { start, end };
          isBatch = true;
          break;
        }
      }
    }

    if (!episodeRange && !isBatch) {
      const clean = stripResolutions(name);
      const epPatterns = [
        /[Ss](\d+)[Ee](\d+)/,
        /[Ee]p(?:isode)?\s*(\d+)/i,
        /[Ee](\d{2,4})(?:\s|$)/,
        /(?:^|\s)-?\s*(\d{1,4})\s*(?:$|\s)/,
        /[\(\[](\d{1,4})[\)\]]/,
      ];
      for (let pat of epPatterns) {
        const match = clean.match(pat);
        if (match) {
          if (match.length === 3) {
            episode = parseInt(match[2]);
          } else if (match.length === 2) {
            const num = parseInt(match[1]);
            if (!isNaN(num) && num > 0 && num < 10000) {
              episode = num;
            }
          }
          break;
        }
      }
    }

    if (episodeRange && episodeRange.start > episodeRange.end) {
      episode = episodeRange.start;
      episodeRange = null;
      isBatch = false;
    }

    return { episode, episodeRange, isBatch };
  }

  const enriched = torrents.map(t => {
    let normalized = t.name
      .replace(/\[.*?\]/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\b(1080p|720p|2160p|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit|Dual Audio|Multi Sub|Multi-Subs|Dual-Audio|VOSTFR|SUBFRENCH|READNFO)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const info = extractEpisodeInfo(t.name);
    return { ...t, normalized, ...info };
  });

  const batches = enriched.filter(t => t.isBatch || t.episodeRange);
  const singles = enriched.filter(t => !t.isBatch && !t.episodeRange);

  const epGroups = new Map();
  singles.forEach(t => {
    const key = t.episode !== null ? `ep_${t.episode}` : `noep_${t.normalized}`;
    if (!epGroups.has(key)) epGroups.set(key, []);
    epGroups.get(key).push(t);
  });

  const bestSingles = [];
  for (let [key, group] of epGroups) {
    const seenNames = new Set();
    const sortedGroup = group.sort((a, b) => {
      if (a.seeders !== b.seeders) return b.seeders - a.seeders;
      return parseSize(b.size) - parseSize(a.size);
    });
    const unique = [];
    for (let t of sortedGroup) {
      const key = t.normalized;
      if (!seenNames.has(key)) {
        seenNames.add(key);
        unique.push(t);
      }
    }
    bestSingles.push(...unique);
  }

  const batchGroups = new Map();
  batches.forEach(t => {
    const key = t.normalized;
    if (!batchGroups.has(key)) batchGroups.set(key, []);
    batchGroups.get(key).push(t);
  });

  const bestBatches = [];
  for (let [key, group] of batchGroups) {
    const withRange = group.filter(t => t.episodeRange);
    const withoutRange = group.filter(t => !t.episodeRange);
    const sorted = [...withRange, ...withoutRange].sort((a, b) => {
      if (a.seeders !== b.seeders) return b.seeders - a.seeders;
      return parseSize(b.size) - parseSize(a.size);
    });
    const seen = new Set();
    const unique = [];
    for (let t of sorted) {
      const key = t.normalized;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
      }
    }
    bestBatches.push(...unique);
  }

  const combined = [...bestBatches, ...bestSingles];

  combined.sort((a, b) => {
    if (a.isBatch && !b.isBatch) return -1;
    if (!a.isBatch && b.isBatch) return 1;
    if (a.episode !== null && b.episode !== null) return a.episode - b.episode;
    return b.seeders - a.seeders;
  });

  return combined.map(t => {
    let info = t.size ? `Size: ${t.size}` : '';
    if (t.episodeRange) {
      info = `Episodes ${t.episodeRange.start}-${t.episodeRange.end} · ${info}`;
    } else if (t.episode !== null) {
      info = `Episode ${t.episode} · ${info}`;
    }
    return {
      name: t.name,
      magnet: t.magnet,
      size: t.size,
      seeders: t.seeders,
      leechers: t.leechers,
      uploader: t.uploader || '',
      type: (t.isBatch || t.episodeRange) ? 'batch' : 'single',
      description: info
    };
  });
}

const categoryMap = {
  Anime: { source: 'anilist', type: 'anime' },
  Manga: { source: 'anilist', type: 'manga' },
  Hollywood: { source: 'tmdb', media: 'movie', label: 'Hollywood', discover: { region: 'US' } },
  Bollywood: { source: 'tmdb_list', listId: '8027', label: 'Bollywood' },
  Animation: { source: 'tmdb', media: 'movie', label: 'Animation', discover: { with_genres: '16', region: 'US' } },
  Asian: { source: 'tmdb_list', listId: '3322', label: 'Asian' },
  Tokusatsu: { source: 'tmdb', media: 'tv', label: 'Tokusatsu', discover: { with_keywords: '317204' }, fallback: { with_origin_country: 'JP', with_genres: '10759,10765' } }
};

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(prompt) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const res = await fetch(GROQ_API_URL, {
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

app.get('/api/trending', async (req, res) => {
  try {
    const category = req.query.category || 'Anime';
    const page = parseInt(req.query.page) || 1;
    const config = categoryMap[category];
    if (!config) return res.status(400).json({ error: 'Invalid category' });
    let items = [];
    if (config.source === 'anilist') {
      const query = `
        query($type: MediaType, $sort: [MediaSort], $page: Int) {
          Page(page: $page, perPage: 20) {
            media(type: $type, sort: $sort, status: RELEASING) {
              title { romaji english native }
              seasonYear
              coverImage { medium large }
            }
          }
        }
      `;
      const variables = { type: config.type.toUpperCase(), sort: ['TRENDING_DESC', 'POPULARITY_DESC'], page };
      const data = await fetchAniList(query, variables);
      items = (data.Page.media || []).map(item => {
        const title = item.title?.romaji || item.title?.english || item.title?.native || 'Unknown';
        const year = item.seasonYear || '';
        const sub = config.type === 'anime' ? `Anime · ${year || 'Latest'}` : `Manga · ${year || 'Popular'}`;
        const cls = getGradientClass(title);
        const poster = item.coverImage?.large || item.coverImage?.medium || '';
        return [title, sub, cls, Math.random() > 0.5, poster];
      });
    } else if (config.source === 'tmdb_list') {
      const results = await fetchTmdbList(config.listId, page);
      items = results.map(item => {
        const title = item.title || item.name || 'Unknown';
        const year = item.release_date || item.first_air_date || '';
        const yr = year ? year.substring(0, 4) : 'Latest';
        const sub = `${config.label || 'Film'} · ${yr}`;
        const cls = getGradientClass(title);
        const poster = item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '';
        return [title, sub, cls, Math.random() > 0.5, poster];
      });
    } else if (config.source === 'tmdb') {
      let results = [];
      let discoverParams = { sort_by: 'popularity.desc', page, ...config.discover };
      if (category === 'Tokusatsu' && config.discover?.with_keywords) {
        const keywordResults = await fetchTmdb(`discover/${config.media}`, discoverParams);
        if (keywordResults.length >= 6) results = keywordResults;
        else {
          const fallbackParams = { sort_by: 'popularity.desc', page, ...config.fallback };
          results = await fetchTmdb(`discover/${config.media}`, fallbackParams);
        }
      } else {
        results = await fetchTmdb(`discover/${config.media}`, discoverParams);
      }
      items = results.map(item => {
        const title = item.title || item.name || 'Unknown';
        const year = item.release_date || item.first_air_date || '';
        const yr = year ? year.substring(0, 4) : 'Latest';
        const mediaLabel = config.media === 'movie' ? 'Film' : 'Series';
        const sub = `${config.label || mediaLabel} · ${yr}`;
        const cls = getGradientClass(title);
        const poster = item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '';
        return [title, sub, cls, Math.random() > 0.5, poster];
      });
    }
    res.json({ category, items });
  } catch (err) {
    console.error('Trending error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch trending' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const category = req.query.category || 'Any';
    const quality = req.query.quality || 'Any';
    const source = req.query.source || 'Any';
    const language = req.query.language || 'Any';
    if (!q) return res.json({ query: q, category, items: [] });
    const targets = category === 'Any' ? Object.keys(categoryMap) : [category];
    let results = [];
    for (let cat of targets) {
      const config = categoryMap[cat];
      if (!config) continue;
      if (config.source === 'anilist') {
        const query = `
          query($search: String, $type: MediaType, $perPage: Int) {
            Page(page: 1, perPage: $perPage) {
              media(search: $search, type: $type) {
                title { romaji english native }
                seasonYear
                coverImage { medium large }
              }
            }
          }
        `;
        const variables = { search: q, type: config.type.toUpperCase(), perPage: 5 };
        const data = await fetchAniList(query, variables);
        const items = (data.Page.media || []).map(item => {
          const title = item.title?.romaji || item.title?.english || item.title?.native || 'Unknown';
          const year = item.seasonYear || '';
          const sub = config.type === 'anime' ? `Anime · ${year || 'Latest'}` : `Manga · ${year || 'Popular'}`;
          const cls = getGradientClass(title);
          const poster = item.coverImage?.large || item.coverImage?.medium || '';
          return [title, sub, cls, Math.random() > 0.5, poster];
        });
        results.push(...items);
      } else if (config.source === 'tmdb_list' && TMDB_API_KEY) {
        const listItems = await fetchTmdbList(config.listId, 1);
        const items = listItems.slice(0, 5).map(item => {
          const title = item.title || item.name || 'Unknown';
          const year = item.release_date || item.first_air_date || '';
          const yr = year ? year.substring(0, 4) : 'Latest';
          const sub = `${config.label || 'Film'} · ${yr}`;
          const cls = getGradientClass(title);
          const poster = item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '';
          return [title, sub, cls, Math.random() > 0.5, poster];
        });
        results.push(...items);
      } else if (config.source === 'tmdb' && TMDB_API_KEY) {
        let url;
        if (quality !== 'Any' || source !== 'Any' || language !== 'Any') {
          const params = new URLSearchParams({
            api_key: TMDB_API_KEY,
            language: 'en-US',
            sort_by: 'popularity.desc',
            include_adult: false,
          });
          if (quality && quality !== 'Any') {
          }
          if (source && source !== 'Any') {
          }
          if (language && language !== 'Any') {
            params.set('with_original_language', language.toLowerCase());
          }
          url = `https://api.themoviedb.org/3/discover/${config.media}?${params.toString()}`;
        } else {
          url = `https://api.themoviedb.org/3/search/${config.media}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US`;
        }
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const items = (data.results || []).slice(0, 5).map(item => {
            const title = item.title || item.name || 'Unknown';
            const year = item.release_date || item.first_air_date || '';
            const yr = year ? year.substring(0, 4) : 'Latest';
            const mediaLabel = config.media === 'movie' ? 'Film' : 'Series';
            const sub = `${config.label || mediaLabel} · ${yr}`;
            const cls = getGradientClass(title);
            const poster = item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '';
            return [title, sub, cls, Math.random() > 0.5, poster];
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
    res.json({ query: q, category, items: unique.slice(0, 30) });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/torrents', async (req, res) => {
  try {
    let title = req.query.title || '';
    const category = req.query.category || 'Anime';
    const source = req.query.source || 'auto';
    const quality = req.query.quality || 'Any';
    const srcFilter = req.query.srcFilter || 'Any';
    const episode = req.query.episode || null;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!title) return res.status(400).json({ error: 'Title required' });

    let searchTitle = title;
    const animeLike = ['Anime', 'Manga', 'Tokusatsu'];
    if (episode) {
      searchTitle = `${title} ${episode}`;
    } else if (animeLike.includes(category)) {
      searchTitle = `${title} batch`;
    }

    const result = await getTorrents(searchTitle, category, source, episode);
    let filtered = filterByQualitySource(result.results, quality, srcFilter);
    const total = filtered.length;
    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);
    const paginated = filtered.slice(start, end);

    res.json({
      title,
      category,
      source: result.source,
      total,
      page,
      limit,
      torrents: paginated,
      hasMore: end < total
    });
  } catch (err) {
    console.error('Torrent error:', err);
    res.status(500).json({ error: 'Failed to fetch torrents' });
  }
});

app.get('/api/details', async (req, res) => {
  try {
    const title = req.query.title || '';
    const source = req.query.source || 'anilist';
    const type = req.query.type || 'anime';
    let description = `Showing releases for ${title}.`;
    let files = [];
    if (source === 'anilist') {
      const query = `
        query($search: String, $type: MediaType) {
          Page(page: 1, perPage: 1) {
            media(search: $search, type: $type) {
              title { romaji english native }
              description
              seasonYear
              episodes
              chapters
              volumes
              genres
              coverImage { large }
            }
          }
        }
      `;
      const variables = { search: title, type: type.toUpperCase() };
      const data = await fetchAniList(query, variables);
      const item = data.Page.media?.[0];
      if (item) {
        description = item.description ? item.description.replace(/<[^>]*>/g, '') : 'No description.';
        const genres = (item.genres || []).join(', ');
        const count = type === 'anime' ? item.episodes : item.chapters || item.volumes;
        files = [
          { label: 'Batch Release', badge: 'BATCH', description: `${genres} - ${count || '?'} ${type==='anime'?'episodes':'chapters'}`, magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_batch` },
          { label: type==='anime'?'Season 1':'Volume 1', badge: '720p', description: `First ${type==='anime'?'season':'volume'}`, magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_s1` }
        ];
      }
    } else if (source === 'tmdb' && TMDB_API_KEY) {
      const url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=en-US`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const item = data.results?.[0];
        if (item) {
          description = item.overview || 'No description.';
          const yr = (item.release_date || item.first_air_date || '').substring(0, 4) || 'Latest';
          files = [
            { label: '1080p BluRay', badge: 'BATCH', description: `Full ${type==='movie'?'movie':'series'} - ${yr}`, magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_1080p` },
            { label: '720p WebDL', badge: 'ALT', description: `Smaller encode - ${yr}`, magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_720p` }
          ];
        }
      }
    }
    res.json({ title, description, files });
  } catch (err) {
    console.error('Details error:', err);
    res.status(500).json({ error: 'Details failed' });
  }
});

function getGradientClass(title) {
  const hash = title.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const classes = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'];
  return classes[hash % classes.length];
}

app.get('/', (req, res) => res.send('KITO API running.'));
app.listen(PORT, () => console.log(`KITO backend on port ${PORT}`));