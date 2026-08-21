const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;

let cheerio = null;
try {
  cheerio = require('cheerio');
} catch (e) {
  console.warn('cheerio not installed');
}

app.use(cors());
app.options('*', cors());
app.use(express.json());

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TORRENTCLAW_API_KEY = process.env.TORRENTCLAW_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w300';
const ANILIST_API = 'https://graphql.anilist.co';

const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

function cleanupCache() {
  const now = Date.now();
  for (let [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
}
setInterval(cleanupCache, 60 * 60 * 1000);

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

function getCategories() {
  return Object.keys(categoryConfig);
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
  const classes = ['a1','a2','a3','a4','a5','a6','a7','a8','a9','a10','a11','a12'];
  return classes[hash % classes.length];
}

function mediaToCard(media) {
  const sub = media.mediaType === 'movie' ? `Film · ${media.year || 'Latest'}` : `Series · ${media.year || 'Latest'}`;
  return {
    title: media.title,
    sub: sub,
    gradient: getGradientClass(media.title),
    poster: media.poster,
    id: media.id,
    provider: media.provider,
    providerId: media.providerId,
    hasRelease: false,
    hasBatch: false,
    year: media.year,
    mediaType: media.mediaType,
    episodes: media.episodes,
    genres: media.genres,
    status: media.status,
    category: media.category
  };
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
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
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
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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
  if (!cheerio) return [];
  const searchUrl = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(title)}`;
  const res = await fetch(searchUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(8000)
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const results = [];
  $('table.torrent-list tbody tr').each((i, row) => {
    if (i >= 100) return false;
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
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
    signal: AbortSignal.timeout(8000)
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

function extractEpisodeNumber(name) {
  const patterns = [
    /[Ss](\d+)[Ee](\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)/i,
    /[Ee](\d{2,3})(?![0-9])/,
    /(?:^|\s)-?(\d{1,3})\s*(?:$|\s)/
  ];
  for (let pat of patterns) {
    const match = name.match(pat);
    if (match) {
      let num = parseInt(match[1]);
      if (num > 0 && num < 1000) return num;
    }
  }
  return null;
}

function extractEpisodeRange(name) {
  const patterns = [
    /(\d+)\s*[-–]\s*(\d+)/,
    /[Ss](\d+)[Ee](\d+)\s*[-–]\s*[Ee]?(\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)\s*[-–]\s*(\d+)/i,
    /[Ee](\d+)\s*[-–]\s*[Ee]?(\d+)/
  ];
  for (let pat of patterns) {
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
        return { start, end };
      }
    }
  }
  return null;
}

function isBatchRelease(name) {
  const lower = name.toLowerCase();
  return /batch|complete|全集|season pack|all episodes|full season|season \d+ (complete|full)|s\d+ (complete|full)/i.test(lower);
}

function parseQuality(name) {
  const match = name.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function parseSource(name) {
  const match = name.match(/\b(WEB-DL|WEBRip|BluRay|DVD|HDTV)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function cleanTitle(name) {
  return name.replace(/\[.*?\]|\(.*?\)/g, '')
    .replace(/\b(1080p|720p|2160p|480p|360p|4k|8k|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit|Dual Audio|Multi Sub|Multi-Subs|Dual-Audio|VOSTFR|SUBFRENCH|READNFO)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBatchTitle(name) {
  let cleaned = cleanTitle(name);
  const range = extractEpisodeRange(name);
  if (range) {
    cleaned = cleaned.replace(/\d+\s*[-–]\s*\d+/, '');
  }
  const epNum = extractEpisodeNumber(name);
  if (epNum) {
    cleaned = cleaned.replace(/\b\d+\b/, '');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

function jaccardSimilarity(str1, str2) {
  const words1 = new Set(str1.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const words2 = new Set(str2.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

function scoreRelease(release, media) {
  let score = 0;
  const normalizedName = release.normalized || release.name;
  const titleMatch = normalizedName.toLowerCase().includes(media.title.toLowerCase());
  const altTitles = [media.titles?.romaji, media.titles?.english, media.titles?.native].filter(Boolean);
  let altMatch = false;
  for (let t of altTitles) {
    if (t && normalizedName.toLowerCase().includes(t.toLowerCase())) {
      altMatch = true;
      break;
    }
  }
  if (titleMatch || altMatch) {
    score += 100;
  } else {
    score -= 200;
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
  return score;
}

function formatRelease(t, type) {
  let description = '';
  if (t.range) {
    description = `Episodes ${t.range.start}-${t.range.end} · Size: ${t.size}`;
  } else if (t.episode !== null) {
    description = `Episode ${t.episode} · Size: ${t.size}`;
  } else {
    description = `Size: ${t.size}`;
  }
  return {
    name: t.name,
    magnet: t.magnet,
    size: t.size,
    seeders: t.seeders,
    leechers: t.leechers,
    uploader: t.uploader || '',
    type: type,
    quality: t.quality,
    description: description,
    score: t.score
  };
}

function deduplicateAndRank(torrents, media) {
  if (!torrents || torrents.length === 0) return [];

  torrents = torrents.filter(t => t.seeders > 0);

  const enriched = torrents.map(t => {
    const isBatch = isBatchRelease(t.name);
    const episode = extractEpisodeNumber(t.name);
    const range = extractEpisodeRange(t.name);
    const quality = parseQuality(t.name);
    const sourceType = parseSource(t.name);
    const normalized = cleanTitle(t.name);
    const batchKey = normalizeBatchTitle(t.name);

    return {
      ...t,
      isBatch,
      episode,
      range,
      quality,
      sourceType,
      normalized,
      batchKey,
      score: 0
    };
  });

  const titleWords = new Set();
  const allTitles = [media.title, media.titles?.romaji, media.titles?.english, media.titles?.native].filter(Boolean);
  allTitles.forEach(t => {
    t.split(/\s+/).forEach(w => titleWords.add(w.toLowerCase()));
  });

  const filtered = enriched.filter(t => {
    const nameWords = t.name.toLowerCase().split(/\s+/);
    let match = false;
    for (let word of titleWords) {
      if (nameWords.some(w => w.includes(word) || word.includes(w))) {
        match = true;
        break;
      }
    }
    if (!match) return false;

    const sim = jaccardSimilarity(t.name, allTitles.join(' '));
    return sim >= 0.15;
  });

  if (filtered.length === 0) return [];

  const batches = filtered.filter(t => t.isBatch || t.range);
  const singles = filtered.filter(t => !t.isBatch && !t.range);

  let bestBatches = [];
  let bestSingles = [];

  if (batches.length > 0) {
    const batchGroups = new Map();
    batches.forEach(t => {
      const key = t.batchKey || t.normalized;
      if (!batchGroups.has(key)) batchGroups.set(key, []);
      batchGroups.get(key).push(t);
    });
    for (let [key, group] of batchGroups) {
      const scored = group.map(t => ({ ...t, score: scoreRelease(t, media) }));
      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best.score > 0) bestBatches.push(best);
    }
    bestBatches.sort((a,b) => b.score - a.score);
  }

  if (bestBatches.length > 0) {
    return bestBatches.map(t => formatRelease(t, 'batch'));
  }

  if (singles.length > 0) {
    const epGroups = new Map();
    singles.forEach(t => {
      const key = t.episode !== null ? `ep_${t.episode}` : t.normalized;
      if (!epGroups.has(key)) epGroups.set(key, []);
      epGroups.get(key).push(t);
    });
    for (let [key, group] of epGroups) {
      const scored = group.map(t => ({ ...t, score: scoreRelease(t, media) }));
      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best.score > 0) bestSingles.push(best);
    }
    bestSingles.sort((a,b) => (a.episode || 0) - (b.episode || 0) || b.score - a.score);
    return bestSingles.map(t => formatRelease(t, 'single'));
  }

  return [];
}

const releaseCheckCache = new Map();

async function quickReleaseCheck(media) {
  const key = media.title.toLowerCase();
  if (releaseCheckCache.has(key)) return releaseCheckCache.get(key);

  try {
    const results = await searchTorrentClaw(media.title);
    const hasRelease = results.length > 0;
    const hasBatch = results.some(t => isBatchRelease(t.name));
    const result = { hasRelease, hasBatch };
    releaseCheckCache.set(key, result);
    setTimeout(() => releaseCheckCache.delete(key), 30 * 60 * 1000);
    return result;
  } catch {
    return { hasRelease: true, hasBatch: false };
  }
}

async function searchAnimeReleases(media) {
  const queries = [media.title];
  if (media.year) {
    queries.push(`${media.title} ${media.year}`);
    queries.push(`${media.title} ${media.year} batch`);
    queries.push(`${media.title} ${media.year} complete`);
  }
  if (!media.title.toLowerCase().includes('batch')) {
    queries.push(`${media.title} batch`);
    queries.push(`${media.title} complete`);
  }
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
        for (let q of queries) {
          const r = await searchTorrentClaw(q);
          if (r.length > 0) { results = r; break; }
        }
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
  const ranked = deduplicateAndRank(rawResults, media);
  return ranked.slice(0, 100);
}

async function searchMovieReleases(media) {
  const queries = [media.title];
  if (media.year) queries.push(`${media.title} ${media.year}`);
  const rawResults = [];
  const sources = ['torrentclaw', 'yts'];

  for (let src of sources) {
    try {
      let results = [];
      if (src === 'torrentclaw') {
        for (let q of queries) {
          const r = await searchTorrentClaw(q);
          if (r.length > 0) { results = r; break; }
        }
      } else if (src === 'yts') {
        for (let q of queries) {
          const r = await searchYTS(q);
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
  const ranked = deduplicateAndRank(rawResults, media);
  return ranked.slice(0, 20);
}

async function searchSeriesReleases(media) {
  const queries = [media.title];
  if (media.year) queries.push(`${media.title} ${media.year}`);
  const rawResults = [];
  const sources = ['torrentclaw', 'eztv'];

  for (let src of sources) {
    try {
      let results = [];
      if (src === 'torrentclaw') {
        for (let q of queries) {
          const r = await searchTorrentClaw(q);
          if (r.length > 0) { results = r; break; }
        }
      } else if (src === 'eztv') {
        for (let q of queries) {
          const r = await searchEZTV(q);
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
  const ranked = deduplicateAndRank(rawResults, media);
  return ranked.slice(0, 100);
}

async function searchReleases(media) {
  const category = getCategory(media.category);
  if (!category || !category.adapter) return [];
  if (category.adapter === 'anime' && category.mediaType === 'series') {
    return searchAnimeReleases(media);
  } else if (category.adapter === 'movie' && category.mediaType === 'movie') {
    return searchMovieReleases(media);
  } else if (category.adapter === 'series') {
    return searchSeriesReleases(media);
  }
  return [];
}

function filterReleasesByQuality(releases, quality) {
  if (!quality || quality === 'Any') return releases;
  return releases.filter(r => r.quality === quality.toLowerCase() || r.quality === quality);
}

function getRecommendations(bookmarks) {
  const mediaTypes = {};
  bookmarks.forEach(b => {
    if (b.category) {
      mediaTypes[b.category] = (mediaTypes[b.category] || 0) + 1;
    }
  });
  const topCategories = Object.entries(mediaTypes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(c => c[0]);
  return { categories: topCategories };
}

async function getForYouRecommendations(bookmarks) {
  if (!bookmarks || bookmarks.length === 0) return [];
  const profile = getRecommendations(bookmarks);
  const results = [];
  const targetCategories = profile.categories.length > 0 ? profile.categories : ['anime'];

  for (let catId of targetCategories) {
    const config = getCategory(catId);
    if (!config) continue;

    if (config.metadataProvider === 'anilist') {
      const query = `
        query($type: MediaType, $perPage: Int) {
          Page(page: 1, perPage: $perPage) {
            media(type: $type, sort: POPULARITY_DESC) {
              id title { romaji english native } seasonYear coverImage { medium large } format episodes chapters status genres
            }
          }
        }
      `;
      const type = 'ANIME';
      const variables = { type, perPage: 4 };
      try {
        const data = await fetchAniList(query, variables);
        const items = (data.Page.media || []).map(item => {
          const media = normalizeAniListMedia(item, catId);
          return mediaToCard(media);
        });
        results.push(...items);
      } catch (err) {
        console.warn('ForYou AniList error:', err.message);
      }
    } else if (config.metadataProvider === 'tmdb' && TMDB_API_KEY) {
      const mediaType = config.mediaType === 'movie' ? 'movie' : 'tv';
      const params = { sort_by: 'popularity.desc', page: 1 };
      if (catId === 'hollywood') { params.region = 'US'; params.language = 'en'; }
      else if (catId === 'bollywood') { params.with_original_language = 'hi'; params.region = 'IN'; }
      else if (catId === 'asian') { params.with_original_language = 'ja|ko|zh'; params.region = 'JP|KR|CN'; }
      else if (catId === 'animation') { params.with_genres = '16'; }
      else if (catId === 'tokusatsu') { params.with_keywords = '317204'; }
      try {
        const raw = await fetchTmdb(`discover/${mediaType}`, params);
        const items = raw.slice(0, 4).map(item => {
          const media = normalizeTmdbMedia(item, catId);
          return mediaToCard(media);
        });
        results.push(...items);
      } catch (err) {
        console.warn('ForYou TMDB error:', err.message);
      }
    }
  }

  const seen = new Set();
  const unique = results.filter(item => {
    const key = item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const checked = await Promise.all(unique.map(async (card) => {
    const check = await quickReleaseCheck(card);
    return { ...card, hasRelease: check.hasRelease, hasBatch: check.hasBatch };
  }));

  return checked.slice(0, 8);
}

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const categoryId = req.query.category || 'any';
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 20;

    if (!q) return res.json({ query: q, category: categoryId, items: [], page, perPage, total: 0 });

    const categories = categoryId === 'any' ? getCategories() : [categoryId];
    let allResults = [];

    for (let catId of categories) {
      const config = getCategory(catId);
      if (!config) continue;

      if (config.metadataProvider === 'anilist') {
        const query = `
          query($search: String, $type: MediaType, $page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
              pageInfo { hasNextPage }
              media(search: $search, type: $type) {
                id title { romaji english native } seasonYear coverImage { medium large } format episodes chapters status genres
              }
            }
          }
        `;
        const type = 'ANIME';
        const variables = { search: q, type, page, perPage };
        const data = await fetchAniList(query, variables);
        const items = (data.Page.media || []).map(item => {
          const media = normalizeAniListMedia(item, catId);
          return mediaToCard(media);
        });
        allResults.push(...items);
      } else if (config.metadataProvider === 'tmdb' && TMDB_API_KEY) {
        const mediaType = config.mediaType === 'movie' ? 'movie' : 'tv';
        let params = { query: q, page };
        if (catId === 'hollywood') { params.region = 'US'; params.language = 'en'; }
        else if (catId === 'bollywood') { params.with_original_language = 'hi'; params.region = 'IN'; }
        else if (catId === 'asian') { params.with_original_language = 'ja|ko|zh'; params.region = 'JP|KR|CN'; }
        else if (catId === 'animation') { params.with_genres = '16'; }
        else if (catId === 'tokusatsu') { params.with_keywords = '317204'; }
        const url = new URL(`https://api.themoviedb.org/3/search/${mediaType}`);
        url.searchParams.set('api_key', TMDB_API_KEY);
        url.searchParams.set('language', 'en-US');
        for (let [key, val] of Object.entries(params)) {
          if (val !== undefined && val !== null && val !== '') url.searchParams.set(key, val);
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          const items = (data.results || []).slice(0, perPage).map(item => {
            const media = normalizeTmdbMedia(item, catId);
            return mediaToCard(media);
          });
          allResults.push(...items);
        }
      }
    }

    const seen = new Set();
    const unique = allResults.filter(item => {
      const key = item.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const checked = await Promise.all(unique.map(async (card) => {
      const check = await quickReleaseCheck(card);
      return { ...card, hasRelease: check.hasRelease, hasBatch: check.hasBatch };
    }));

    const start = (page - 1) * perPage;
    const end = start + perPage;
    const paginated = checked.slice(start, end);

    res.json({
      query: q,
      category: categoryId,
      page,
      perPage,
      total: checked.length,
      items: paginated
    });
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
        episodes: mediaObject.episodes,
        genres: mediaObject.genres,
        status: mediaObject.status
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
        type: r.type,
        quality: r.quality,
        description: r.description
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
      return res.json({ items: [], message: 'Bookmark some titles to get personalized recommendations.' });
    }
    const items = await getForYouRecommendations(bookmarks);
    res.json({ items });
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/', (req, res) => res.send('KITO API running.'));
app.listen(PORT, () => console.log(`KITO backend on port ${PORT}`));