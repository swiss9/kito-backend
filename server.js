const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w300';
const ANILIST_API = 'https://graphql.anilist.co';
const MYDRAMALIST_API = 'https://mydramalist.com/api/v1';

function getGradientClass(title) {
  const hash = title.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const classes = ['a1','a2','a3','a4','a5','a6','a7','a8','a9','a10','a11','a12'];
  return classes[hash % classes.length];
}

function mapAniListItem(item, type) {
  const title = item.title?.romaji || item.title?.english || item.title?.native || 'Unknown';
  const year = item.seasonYear || '';
  const sub = type === 'anime' ? `Anime · ${year || 'Latest'}` : `Manga · ${year || 'Popular'}`;
  const cls = getGradientClass(title);
  const poster = item.coverImage?.large || item.coverImage?.medium || '';
  return [title, sub, cls, Math.random() > 0.5, poster];
}

function mapTmdbItem(item, mediaType, label) {
  const title = item.title || item.name || 'Unknown';
  const year = item.release_date || item.first_air_date || '';
  const yr = year ? year.substring(0, 4) : 'Latest';
  const mediaLabel = mediaType === 'movie' ? 'Film' : 'Series';
  const sub = `${label || mediaLabel} · ${yr}`;
  const cls = getGradientClass(title);
  const poster = item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '';
  return [title, sub, cls, Math.random() > 0.5, poster];
}

function mapMdlItem(item) {
  const title = item.title || item.name || 'Unknown';
  const year = item.year || item.release_date || '';
  const yr = year ? year.toString().substring(0,4) : 'Latest';
  const sub = `Series · ${yr}`;
  const cls = getGradientClass(title);
  const poster = item.image || item.poster || '';
  return [title, sub, cls, Math.random() > 0.5, poster];
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

async function fetchMdl(endpoint, params = {}) {
  try {
    const url = new URL(`${MYDRAMALIST_API}/${endpoint}`);
    for (let [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== null && val !== '') url.searchParams.set(key, val);
    }
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KITO/1.0; +https://kito.app)',
        'Accept': 'application/json',
        'Referer': 'https://mydramalist.com/'
      }
    });
    if (!res.ok) {
      console.error(`MDL request failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    if (data.data) return data.data;
    if (data.dramas) return data.dramas;
    if (Array.isArray(data)) return data;
    return [];
  } catch (err) {
    console.error('MDL fetch error:', err.message);
    return null;
  }
}

const categoryMap = {
  Anime: { source: 'anilist', type: 'anime' },
  Manga: { source: 'anilist', type: 'manga' },
  Hollywood: {
    source: 'tmdb',
    media: 'movie',
    label: 'Hollywood',
    discover: { region: 'US' }
  },
  Bollywood: {
    source: 'tmdb',
    media: 'movie',
    label: 'Bollywood',
    discover: { region: 'IN', with_original_language: 'hi' }
  },
  Animation: {
    source: 'tmdb',
    media: 'movie',
    label: 'Animation',
    discover: { with_genres: '16', region: 'US' }
  },
  'K-Drama': {
    source: 'mdl',
    endpoint: 'dramas',
    params: { country: 'South Korea', sort: 'popular' },
    fallback: { source: 'tmdb', media: 'tv', label: 'K-Drama', discover: { with_origin_country: 'KR' } }
  },
  'J-Drama': {
    source: 'mdl',
    endpoint: 'dramas',
    params: { country: 'Japan', sort: 'popular' },
    fallback: { source: 'tmdb', media: 'tv', label: 'J-Drama', discover: { with_origin_country: 'JP' } }
  },
  'C-Drama': {
    source: 'mdl',
    endpoint: 'dramas',
    params: { country: 'China', sort: 'popular' },
    fallback: { source: 'tmdb', media: 'tv', label: 'C-Drama', discover: { with_origin_country: 'CN' } }
  },
  Tokusatsu: {
    source: 'mdl',
    endpoint: 'search',
    params: { q: 'tokusatsu', sort: 'popular' },
    fallback: { source: 'tmdb', media: 'tv', label: 'Tokusatsu', discover: { with_origin_country: 'JP', with_genres: '10759,10765' } }
  }
};

app.get('/api/trending', async (req, res) => {
  try {
    const category = req.query.category || 'Anime';
    const config = categoryMap[category];
    if (!config) return res.status(400).json({ error: 'Invalid category' });
    let items = [];
    if (config.source === 'anilist') {
      const query = `
        query($type: MediaType, $sort: [MediaSort]) {
          Page(page: 1, perPage: 18) {
            media(type: $type, sort: $sort, status: RELEASING) {
              title { romaji english native }
              seasonYear
              coverImage { medium large }
            }
          }
        }
      `;
      const variables = { type: config.type.toUpperCase(), sort: ['TRENDING_DESC', 'POPULARITY_DESC'] };
      const data = await fetchAniList(query, variables);
      items = (data.Page.media || []).map(item => mapAniListItem(item, config.type));
    } else if (config.source === 'tmdb') {
      const discoverParams = { sort_by: 'popularity.desc', page: 1, ...config.discover };
      const results = await fetchTmdb(`discover/${config.media}`, discoverParams);
      items = results.slice(0, 18).map(item => mapTmdbItem(item, config.media, config.label));
    } else if (config.source === 'mdl') {
      let results = await fetchMdl(config.endpoint, config.params);
      if (results === null && config.fallback) {
        console.log(`MDL failed, falling back to ${config.fallback.source} for ${category}`);
        const fallbackConfig = config.fallback;
        const discoverParams = { sort_by: 'popularity.desc', page: 1, ...fallbackConfig.discover };
        const fallbackResults = await fetchTmdb(`discover/${fallbackConfig.media}`, discoverParams);
        items = fallbackResults.slice(0, 18).map(item => mapTmdbItem(item, fallbackConfig.media, fallbackConfig.label));
      } else {
        items = results.slice(0, 18).map(item => mapMdlItem(item));
      }
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
        const items = (data.Page.media || []).map(item => mapAniListItem(item, config.type));
        results.push(...items);
      } else if (config.source === 'tmdb' && TMDB_API_KEY) {
        const url = `https://api.themoviedb.org/3/search/${config.media}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const items = (data.results || []).slice(0, 5).map(item => mapTmdbItem(item, config.media));
          results.push(...items);
        }
      } else if (config.source === 'mdl') {
        let items = await fetchMdl('search', { q, sort: 'popular' });
        if (items === null) {
          continue;
        }
        const mapped = items.slice(0, 5).map(item => mapMdlItem(item));
        results.push(...mapped);
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
          const yr = (item.release_date || item.first_air_date || '').substring(0,4) || 'Latest';
          files = [
            { label: '1080p BluRay', badge: 'BATCH', description: `Full ${type==='movie'?'movie':'series'} - ${yr}`, magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_1080p` },
            { label: '720p WebDL', badge: 'ALT', description: `Smaller encode - ${yr}`, magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_720p` }
          ];
        }
      }
    } else if (source === 'mdl') {
      const results = await fetchMdl('search', { q: title, sort: 'popular' });
      const item = results?.[0];
      if (item) {
        description = item.synopsis || item.overview || 'No description.';
        files = [
          { label: 'Complete Series', badge: 'BATCH', description: `${item.title} - All episodes`, magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_batch` },
          { label: 'Season 1', badge: '720p', description: 'First season', magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g,'_')}_s1` }
        ];
      }
    }
    res.json({ title, description, files });
  } catch (err) {
    console.error('Details error:', err);
    res.status(500).json({ error: 'Details failed' });
  }
});

app.get('/', (req, res) => res.send('KITO API running.'));
app.listen(PORT, () => console.log(`KITO backend on port ${PORT}`));
