const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TORRENTCLAW_API_KEY = process.env.TORRENTCLAW_API_KEY;
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
    limit: 20,
  });
  if (TORRENTCLAW_API_KEY) params.append('apikey', TORRENTCLAW_API_KEY);
  const url = `${baseUrl}?${params.toString()}`;
  const res = await fetch(url);
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
  const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const results = [];
  $('table.torrent-list tbody tr').each((i, row) => {
    if (i >= 10) return false;
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

async function scrape1337x(title) {
  const searchUrl = `https://1337x.to/search/${encodeURIComponent(title)}/1/`;
  const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const html = await res.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const results = [];
  $('tbody tr').each((i, row) => {
    if (i >= 10) return false;
    const tds = $(row).find('td');
    if (tds.length < 4) return;
    const name = $(tds[0]).find('a').last().text().trim();
    const href = $(tds[0]).find('a').attr('href');
    const size = $(tds[1]).text().trim();
    const seeders = parseInt($(tds[2]).text().trim()) || 0;
    const leechers = parseInt($(tds[3]).text().trim()) || 0;
    if (href && name) {
      results.push({
        name,
        magnet: `https://1337x.to${href}`,
        size,
        seeders,
        leechers,
        uploader: ''
      });
    }
  });
  return results;
}

async function getTorrents(title, category, source = 'auto') {
  const cacheKey = `torrents:${source}:${category}:${title.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const fetchFn = async () => {
    let torrents = [];
    let usedSource = source;
    let fallbackChain = [];

    if (category === 'Anime' || category === 'Manga') {
      fallbackChain = ['torrentclaw', 'nyaa', '1337x'];
    } else if (category === 'Tokusatsu') {
      fallbackChain = ['torrentclaw', 'nyaa', '1337x'];
    } else {
      fallbackChain = ['torrentclaw', '1337x'];
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
        } else if (src === '1337x') {
          torrents = await scrape1337x(title);
          usedSource = '1337x';
        }
        if (torrents.length > 0) break;
      } catch (err) {
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

function filterBestTorrents(torrents) {
  if (!torrents || torrents.length === 0) return [];

  const groups = {};
  torrents.forEach(t => {
    const normalized = t.name.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
    if (!groups[normalized]) groups[normalized] = [];
    groups[normalized].push(t);
  });

  const results = [];
  for (let key in groups) {
    const variants = groups[key];
    const batch = variants.find(t =>
      t.name.toLowerCase().includes('batch') ||
      t.name.toLowerCase().includes('complete') ||
      t.name.toLowerCase().includes('全集') ||
      t.name.toLowerCase().includes('season pack')
    );
    if (batch) {
      results.push({ ...batch, type: 'batch' });
    } else {
      const sorted = variants.sort((a, b) => {
        if (a.seeders !== b.seeders) return b.seeders - a.seeders;
        return parseSize(b.size) - parseSize(a.size);
      });
      results.push({ ...sorted[0], type: 'single' });
    }
  }
  return results.slice(0, 2);
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

const categoryMap = {
  Anime: { source: 'anilist', type: 'anime' },
  Manga: { source: 'anilist', type: 'manga' },
  Hollywood: { source: 'tmdb', media: 'movie', label: 'Hollywood', discover: { region: 'US' } },
  Bollywood: { source: 'tmdb_list', listId: '8027', label: 'Bollywood' },
  Animation: { source: 'tmdb', media: 'movie', label: 'Animation', discover: { with_genres: '16', region: 'US' } },
  Asian: { source: 'tmdb_list', listId: '3322', label: 'Asian' },
  Tokusatsu: { source: 'tmdb', media: 'tv', label: 'Tokusatsu', discover: { with_keywords: '317204' }, fallback: { with_origin_country: 'JP', with_genres: '10759,10765' } }
};

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
    const q = (req.query.q || '').trim();
    const category = req.query.category || 'Any';
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
        const url = `https://api.themoviedb.org/3/search/${config.media}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US`;
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
    const title = req.query.title || '';
    const category = req.query.category || 'Anime';
    const source = req.query.source || 'auto';
    if (!title) return res.status(400).json({ error: 'Title required' });
    const result = await getTorrents(title, category, source);
    res.json({
      title,
      category,
      source: result.source,
      torrents: result.results
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
