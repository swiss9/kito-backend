const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const TMDB_API_KEY = process.env.TMDB_API_KEY || 'your_tmdb_api_key_here';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w300';

const ANILIST_API = 'https://graphql.anilist.co';

const categoryMap = {
  Anime: { source: 'anilist', type: 'anime' },
  Manga: { source: 'anilist', type: 'manga' },
  Hollywood: { source: 'tmdb', media: 'movie' },
  'K-Drama': { source: 'tmdb', media: 'tv' },
  'J-Drama': { source: 'tmdb', media: 'tv' },
  'C-Drama': { source: 'tmdb', media: 'tv' },
  Tokusatsu: { source: 'tmdb', media: 'tv' },
  Bollywood: { source: 'tmdb', media: 'movie' }
};

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
  const hasBatch = Math.random() > 0.5;
  return [title, sub, cls, hasBatch, poster];
}

function mapTmdbItem(item, media) {
  const title = item.title || item.name || 'Unknown';
  const year = item.release_date || item.first_air_date || '';
  const yr = year ? year.substring(0, 4) : 'Latest';
  const mediaLabel = media === 'movie' ? 'Film' : 'Series';
  const sub = `${mediaLabel} · ${yr}`;
  const cls = getGradientClass(title);
  const poster = item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '';
  const hasBatch = Math.random() > 0.5;
  return [title, sub, cls, hasBatch, poster];
}

async function fetchAniList(query, variables) {
  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json();
  if (data.errors) {
    throw new Error(data.errors[0].message);
  }
  return data.data;
}

function getTmdbUrl(media) {
  return `https://api.themoviedb.org/3/trending/${media}/week?api_key=${TMDB_API_KEY}&language=en-US`;
}

app.get('/api/trending', async (req, res) => {
  try {
    const category = req.query.category || 'Anime';
    const config = categoryMap[category];
    if (!config) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    let items = [];

    if (config.source === 'anilist') {
      const query = `
        query($type: MediaType, $sort: [MediaSort]) {
          Page(page: 1, perPage: 18) {
            media(type: $type, sort: $sort, status: RELEASING) {
              title {
                romaji
                english
                native
              }
              seasonYear
              format
              episodes
              chapters
              volumes
              status
              averageScore
              popularity
              coverImage {
                medium
                large
              }
            }
          }
        }
      `;
      const variables = {
        type: config.type.toUpperCase(),
        sort: ['TRENDING_DESC', 'POPULARITY_DESC']
      };
      const data = await fetchAniList(query, variables);
      const results = data.Page.media || [];
      items = results.map(item => mapAniListItem(item, config.type));
    } else if (config.source === 'tmdb') {
      const response = await fetch(getTmdbUrl(config.media));
      const data = await response.json();
      const results = data.results || [];
      items = results.map(item => mapTmdbItem(item, config.media));
    }

    res.json({ category, items });
  } catch (error) {
    console.error('Trending fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch trending data' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const category = req.query.category || 'Any';
    let results = [];

    if (!q) {
      return res.json({ query: q, category, items: [] });
    }

    const targetCategories = category === 'Any' ? Object.keys(categoryMap) : [category];

    for (let cat of targetCategories) {
      const config = categoryMap[cat];
      if (!config) continue;

      if (config.source === 'anilist') {
        const query = `
          query($search: String, $type: MediaType, $perPage: Int) {
            Page(page: 1, perPage: $perPage) {
              media(search: $search, type: $type) {
                title {
                  romaji
                  english
                  native
                }
                seasonYear
                format
                episodes
                chapters
                volumes
                status
                averageScore
                popularity
                coverImage {
                  medium
                  large
                }
              }
            }
          }
        `;
        const variables = {
          search: q,
          type: config.type.toUpperCase(),
          perPage: 5
        };
        const data = await fetchAniList(query, variables);
        const items = (data.Page.media || []).map(item => mapAniListItem(item, config.type));
        results.push(...items);
      } else if (config.source === 'tmdb') {
        const url = `https://api.themoviedb.org/3/search/${config.media}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US`;
        const response = await fetch(url);
        const data = await response.json();
        const items = (data.results || []).slice(0, 5).map(item => mapTmdbItem(item, config.media));
        results.push(...items);
      }
    }

    const seen = new Set();
    const unique = [];
    for (let item of results) {
      if (!seen.has(item[0])) {
        seen.add(item[0]);
        unique.push(item);
      }
    }

    res.json({ query: q, category, items: unique.slice(0, 30) });
  } catch (error) {
    console.error('Search error:', error);
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
              title {
                romaji
                english
                native
              }
              description
              seasonYear
              episodes
              chapters
              volumes
              format
              status
              genres
              averageScore
              popularity
              coverImage {
                large
              }
            }
          }
        }
      `;
      const variables = {
        search: title,
        type: type.toUpperCase()
      };
      const data = await fetchAniList(query, variables);
      const item = data.Page.media?.[0];
      if (item) {
        description = item.description ? item.description.replace(/<[^>]*>/g, '') : 'No description available.';
        const genres = (item.genres || []).join(', ');
        const count = type === 'anime' ? item.episodes : item.chapters || item.volumes;
        files = [
          {
            label: 'Batch Release',
            badge: 'BATCH',
            description: `${genres || 'Complete'} - ${count || '?'} ${type === 'anime' ? 'episodes' : 'chapters'}`,
            magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g, '_')}_batch`
          },
          {
            label: type === 'anime' ? 'Season 1' : 'Volume 1',
            badge: '720p',
            description: `First ${type === 'anime' ? 'season' : 'volume'}`,
            magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g, '_')}_s1`
          }
        ];
      }
    } else if (source === 'tmdb') {
      const url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=en-US`;
      const response = await fetch(url);
      const data = await response.json();
      const item = data.results?.[0];
      if (item) {
        description = item.overview || 'No description available.';
        const year = item.release_date || item.first_air_date || '';
        const yr = year ? year.substring(0, 4) : 'Latest';
        files = [
          {
            label: '1080p BluRay',
            badge: 'BATCH',
            description: `Full ${type === 'movie' ? 'movie' : 'series'} - ${yr}`,
            magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g, '_')}_1080p`
          },
          {
            label: '720p WebDL',
            badge: 'ALT',
            description: `Smaller encode - ${yr}`,
            magnet: `magnet:?xt=urn:btih:${title.replace(/\s/g, '_')}_720p`
          }
        ];
      }
    }

    res.json({ title, description, files });
  } catch (error) {
    console.error('Details error:', error);
    res.status(500).json({ error: 'Failed to fetch details' });
  }
});

app.get('/', (req, res) => {
  res.send('KITO API running.');
});

app.listen(PORT, () => {
  console.log(`KITO backend running on port ${PORT}`);
});