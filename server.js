const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options('*', cors());
app.use(express.json());

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TORRENTCLAW_API_KEY = process.env.TORRENTCLAW_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w300';
const ANILIST_API = 'https://graphql.anilist.co';

const CACHE_FILE = path.join(__dirname, 'cache.json');
let cache = {};
let cacheWritePending = false;

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      cache = JSON.parse(data);
      console.log(`Cache loaded from disk (${Object.keys(cache).length} entries)`);
    }
  } catch (e) { console.warn('Failed to load cache', e.message); }
}

function saveCache() {
  if (cacheWritePending) return;
  cacheWritePending = true;
  setImmediate(() => {
    try {
      const tempFile = `${CACHE_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2));
      fs.renameSync(tempFile, CACHE_FILE);
      console.log('Cache saved to disk safely');
    } catch (e) {
      console.warn('Failed to save cache:', e.message);
    }
    cacheWritePending = false;
  });
}

loadCache();

const CACHE_TTL = 12 * 60 * 60 * 1000;
function cleanupCache() {
  const now = Date.now();
  for (const [key, entry] of Object.entries(cache)) {
    if (now - entry.timestamp > CACHE_TTL) {
      delete cache[key];
    }
  }
  saveCache();
}
setInterval(cleanupCache, 60 * 60 * 1000);

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    delete cache[key];
    saveCache();
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
  saveCache();
}

const categoryConfig = {
  anime: {
    id: 'anime',
    label: 'Anime',
    metadataProvider: 'anilist',
    mediaType: 'series',
    adapter: 'anime',
    torrentSources: ['nyaa_rss', 'torrentclaw']
  },
  hollywood: {
    id: 'hollywood',
    label: 'Hollywood',
    metadataProvider: 'tmdb',
    mediaType: 'movie',
    adapter: 'movie',
    torrentSources: ['yts', 'torrentclaw']
  },
  bollywood: {
    id: 'bollywood',
    label: 'Bollywood',
    metadataProvider: 'tmdb',
    mediaType: 'movie',
    adapter: 'movie',
    torrentSources: ['yts', 'torrentclaw']
  },
  animation: {
    id: 'animation',
    label: 'Animation',
    metadataProvider: 'tmdb',
    mediaType: 'movie',
    adapter: 'movie',
    torrentSources: ['yts', 'torrentclaw']
  },
  asian: {
    id: 'asian',
    label: 'CN, KR & JP',
    metadataProvider: 'tmdb',
    mediaType: 'series',
    adapter: 'series',
    torrentSources: ['eztv', 'torrentclaw']
  },
  tokusatsu: {
    id: 'tokusatsu',
    label: 'Tokusatsu',
    metadataProvider: 'tmdb',
    mediaType: 'series',
    adapter: 'anime',
    torrentSources: ['nyaa_rss', 'torrentclaw']
  }
};
function getCategory(id) { return categoryConfig[id] || null; }
function getCategories() { return Object.keys(categoryConfig); }

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(title) {
  return normalizeTitle(title).split(/\s+/);
}

function extractReleaseTitle(name) {
  let clean = name
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(1080p|720p|2160p|480p|360p|4k|8k|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit|Dual Audio|Multi Sub|Multi-Subs|Dual-Audio|VOSTFR|SUBFRENCH|READNFO)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean;
}

function stripSeasonInfo(title) {
  return normalizeTitle(title)
    .replace(/\b(s\d+|season \d+|\d+(st|nd|rd|th) season|part \d+)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRUSTED_GROUPS = [
  'SubsPlease', 'Erai-raws', 'Judas', 'AnimeRG',
  'HorribleSubs', 'Asenshi', 'Commie', 'FFFpeeps',
  'GJM', 'Hatsuyuki', 'Kaleido', 'Kamigami', 'Leopard',
  'Mabuse', 'Mazui', 'Nekomoe', 'Ohys', 'ReinForce',
  'SallySubs', 'SSA', 'Tatsumi', 'Underwater', 'Vivid',
  'Yami', 'ZR'
];

// ---------- Pure JS release name parser ----------
function parseReleaseName(name) {
  const episode = extractEpisodeNumberFromName(name);
  const season = extractSeasonNumberFromName(name);
  const releaseGroup = getReleaseGroup(name);
  const qualityInfo = parseQuality(name);
  const resolution = qualityInfo.label !== 'Unknown' ? qualityInfo.label : null;
  const source = parseSource(name);
  const title = extractReleaseTitle(name);
  return {
    episodeNumber: episode,
    season: season,
    releaseGroup: releaseGroup,
    resolution: resolution,
    source: source,
    title: title
  };
}

function extractEpisodeNumberFromName(name) {
  if (!name) return null;
  let clean = name
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|360p|4k|8k)\b/gi, ' ')
    .replace(/\b(19\d\d|20\d\d)\b/g, ' ');
  const patterns = [
    /[Ss](\d+)[Ee](\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)/i,
    /[Ee](\d{2,3})(?![0-9])/,
    /(?:^|\s)-?\s*(\d{1,3})\s*(?:$|\s)/,
    /\[(\d+)\]/,
    /\((\d+)\)/
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      const num = parseInt(match[match.length - 1]);
      if (num > 0 && num < 1000) return num;
    }
  }
  return null;
}

function extractSeasonNumberFromName(name) {
  if (!name) return null;
  const clean = name.replace(/\[.*?\]|\(.*?\)/g, ' ');
  const ordinalMatch = clean.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  if (ordinalMatch) return parseInt(ordinalMatch[1]);
  const romanMap = { 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6 };
  const romanMatch = clean.match(/\b(II|III|IV|V|VI)\b/);
  if (romanMatch) return romanMap[romanMatch[1]];
  const patterns = [
    /[Ss](\d+)[Ee]\d+/,
    /[Ss]eason\s*(\d+)/i,
    /S(\d+)\s*Complete/i
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      const s = parseInt(match[1]);
      if (s > 0 && s < 100) return s;
    }
  }
  return null;
}

function getReleaseGroup(name) {
  const match = name.match(/\[([^\]]+)\]/);
  return match ? match[1] : null;
}

async function fetchAniList(query, variables) {
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000)
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
  const apiRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!apiRes.ok) return [];
  const data = await apiRes.json();
  return data.results || [];
}

async function searchTorrentClaw(title) {
  const baseUrl = 'https://torrentclaw.com/api/search';
  const params = new URLSearchParams({ q: title, category: 'all', limit: 100 });
  if (TORRENTCLAW_API_KEY) params.append('apikey', TORRENTCLAW_API_KEY);
  const url = `${baseUrl}?${params.toString()}`;
  const apiRes = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!apiRes.ok) throw new Error(`TorrentClaw: ${apiRes.status}`);
  const data = await apiRes.json();
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

const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

async function searchNyaaRSS(title) {
  const url = `https://nyaa.si/?page=rss&c=1_2&q=${encodeURIComponent(title)}`;
  const apiRes = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8000)
  });
  if (!apiRes.ok) throw new Error(`Nyaa RSS: ${apiRes.status}`);
  const text = await apiRes.text();
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(text);
  const items = result.rss?.channel?.item;
  if (!items) return [];
  const itemArray = Array.isArray(items) ? items : [items];
  return itemArray.map(item => {
    const title = item.title || 'Unknown';
    const infoHash = item['nyaa:infoHash'] || '';
    const magnet = infoHash
      ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}${ANIME_TRACKERS}`
      : (item.link || '');
    const size = item['nyaa:size'] || '';
    const seeders = parseInt(item['nyaa:seeders']) || 0;
    const leechers = parseInt(item['nyaa:leechers']) || 0;
    return { name: title, magnet, size, seeders, leechers, uploader: '' };
  });
}

async function searchYTS(title) {
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&limit=50`;
  const apiRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!apiRes.ok) return [];
  const data = await apiRes.json();
  if (data.status !== 'ok') return [];
  const movies = data.data.movies || [];
  const results = [];
  for (const m of movies) {
    if (m.torrents && m.torrents.length) {
      for (const t of m.torrents) {
        const titleName = m.title_long || m.title || 'Unknown';
        const magnet = t.hash
          ? `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(titleName)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80`
          : (t.url || '');
        results.push({
          name: titleName,
          magnet,
          size: t.size || '',
          seeders: t.seeds || 0,
          leechers: t.peers || 0,
          uploader: 'YTS'
        });
      }
    }
  }
  return results;
}

async function searchEZTV(title) {
  const url = `https://eztvx.to/api/get-torrents?query=${encodeURIComponent(title)}&limit=50`;
  const apiRes = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8000)
  });
  if (!apiRes.ok) return [];
  const data = await apiRes.json();
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

function extractEpisodeRange(name) {
  const clean = name.replace(/\[.*?\]|\(.*?\)/g, ' ');
  const patterns = [
    /(\d+)\s*[-–~]\s*(\d+)/,
    /[Ss](\d+)[Ee](\d+)\s*[-–~]\s*[Ee]?(\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)\s*[-–~]\s*(\d+)/i,
    /[Ee](\d+)\s*[-–~]\s*[Ee]?(\d+)/
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      let start, end;
      if (match.length === 3) {
        start = parseInt(match[1]);
        end = parseInt(match[2]);
      } else if (match.length === 4) {
        start = parseInt(match[2]);
        end = parseInt(match[3]);
      } else continue;
      if (start > 0 && end > 0 && start < end && end < 1000) return { start, end };
    }
  }
  return null;
}

function isBatchRelease(name) {
  if (extractEpisodeRange(name)) return true;
  const lower = name.toLowerCase();
  if (/batch|season pack|all episodes|full season|complete series|box set|s\d+ complete|season \d+ complete/i.test(lower)) {
    return true;
  }
  return false;
}

function parseQuality(name) {
  const match = name.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  if (match) {
    const q = match[1].toLowerCase();
    if (q === '2160p' || q === '4k') return { quality: 2160, label: '2160p' };
    if (q === '1080p') return { quality: 1080, label: '1080p' };
    if (q === '720p') return { quality: 720, label: '720p' };
    if (q === '480p') return { quality: 480, label: '480p' };
    if (q === '360p') return { quality: 360, label: '360p' };
  }
  return { quality: 0, label: 'Unknown' };
}

function parseSource(name) {
  const match = name.match(/\b(WEB-DL|WEBRip|BluRay|DVD|HDTV)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function extractMagnetHash(magnet) {
  const match = magnet.match(/btih:([a-fA-F0-9]+)/);
  return match ? match[1].toLowerCase() : null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAniListMedia(item, categoryId, relations = []) {
  const aliases = [
    item.title?.romaji,
    item.title?.english,
    item.title?.native,
    ...(item.synonyms || [])
  ].filter(Boolean);
  return {
    id: `anilist:${item.id}`,
    title: item.title?.romaji || item.title?.english || item.title?.native || 'Unknown',
    aliases,
    year: item.seasonYear || null,
    mediaType: item.format === 'MOVIE' ? 'movie' : 'series',
    episodeCount: item.episodes || null,
    status: item.status || 'UNKNOWN',
    poster: item.coverImage?.large || item.coverImage?.medium || '',
    genres: item.genres || [],
    provider: 'anilist',
    providerId: item.id,
    category: categoryId,
    relations: relations.map(r => ({
      id: r.id,
      title: r.title?.romaji || r.title?.english || r.title?.native || '',
      relationType: r.relationType,
      format: r.format
    }))
  };
}

function normalizeTmdbMedia(item, categoryId) {
  const isMovie = item.media_type === 'movie' || item.release_date;
  return {
    id: `tmdb:${item.id}`,
    title: item.title || item.name || 'Unknown',
    aliases: [item.title || item.name || ''],
    year: (item.release_date || item.first_air_date || '').substring(0, 4) || null,
    mediaType: isMovie ? 'movie' : 'series',
    episodeCount: null,
    status: item.status || 'UNKNOWN',
    poster: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '',
    genres: item.genre_ids || [],
    provider: 'tmdb',
    providerId: item.id,
    category: categoryId,
    relations: []
  };
}

function mediaToCard(media) {
  const sub = media.mediaType === 'movie' ? `Film · ${media.year || 'Latest'}` : `Series · ${media.year || 'Latest'}`;
  return {
    id: media.id,
    title: media.title,
    aliases: media.aliases,
    subtitle: sub,
    category: media.category,
    mediaType: media.mediaType,
    year: media.year,
    episodeCount: media.episodeCount,
    poster: media.poster,
    provider: media.provider,
    providerId: media.providerId,
    hasRelease: false,
    hasBatch: false
  };
}

function getForbiddenRelationTitles(media) {
  const forbidden = [];
  if (media.relations) {
    for (const rel of media.relations) {
      if (rel.title && ['SEQUEL', 'PREQUEL', 'SPIN_OFF', 'ALTERNATIVE', 'SIDE_STORY', 'SUMMARY'].includes(rel.relationType)) {
        forbidden.push(rel.title);
      }
    }
  }
  return forbidden.map(t => normalizeTitle(t)).filter(t => t.length > 2);
}

function getMediaSeason(media) {
  const titles = [media.title, ...(media.aliases || [])];
  for (const t of titles) {
    const parsed = parseReleaseName(t);
    const s = parsed.season;
    if (s !== null) return s;
    const norm = normalizeTitle(t);
    const trailingDigitMatch = norm.match(/\s([2-9])$/);
    if (trailingDigitMatch) return parseInt(trailingDigitMatch[1]);
  }
  return 1;
}

function validateAndScoreRelease(release, media) {
  const name = release.name;
  const parsed = parseReleaseName(name);
  const releaseTitle = normalizeTitle(parsed.title || extractReleaseTitle(name));
  const mediaTitles = [media.title, ...media.aliases].map(normalizeTitle);
  const forbiddenTitles = getForbiddenRelationTitles(media);
  const releaseTitleStripped = stripSeasonInfo(releaseTitle);
  const mediaTitlesStripped = mediaTitles.map(t => stripSeasonInfo(t));

  // Title match
  let titleMatch = false;
  for (let i = 0; i < mediaTitlesStripped.length; i++) {
    const mt = mediaTitlesStripped[i];
    if (!mt || !releaseTitleStripped) continue;
    if (releaseTitleStripped.includes(mt)) {
      titleMatch = true;
      break;
    }
    if (releaseTitleStripped.length >= 8 && mt.includes(releaseTitleStripped)) {
      titleMatch = true;
      break;
    }
  }
  if (!titleMatch) return null;

  // ---- Blacklist for series (movies, OVAs, spin-offs) ----
  if (media.mediaType === 'series') {
    const blacklist = ['movie', 'film', 'ova', 'special', 'spin-off', 'spin off', 'rock lee', 'guardians of the crescent moon', 'stone of gelel', 'ninja clash'];
    const lowerRelease = releaseTitle.toLowerCase();
    for (const term of blacklist) {
      if (lowerRelease.includes(term)) {
        return null;
      }
    }
  }

  // Season check
  const mediaSeason = getMediaSeason(media);
  const releaseSeason = parsed.season ?? 1;

  if (releaseSeason !== mediaSeason) {
    const relTitleNorm = normalizeTitle(extractReleaseTitle(name));
    if (mediaSeason === 1) {
      if (releaseSeason > 1 || /\b(s0?[2-9]|season 0?[2-9])\b/i.test(relTitleNorm)) {
        return null;
      }
    } else {
      const seasonRegex = new RegExp(`\\b(season\\s*0?${mediaSeason}|s0?${mediaSeason})\\b`, 'i');
      const romanMap = { 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v' };
      const romanString = romanMap[mediaSeason] ? `\\b${romanMap[mediaSeason]}\\b` : null;
      let matchesSeason = seasonRegex.test(relTitleNorm);
      if (!matchesSeason && romanString) {
        matchesSeason = new RegExp(romanString, 'i').test(relTitleNorm);
      }
      if (!matchesSeason) {
        const cleanTitleWithoutEp = parsed.title
          ? normalizeTitle(parsed.title)
          : relTitleNorm.replace(/\s*-\s*\d+.*$/, '');
        matchesSeason = new RegExp(`\\b0?${mediaSeason}\\b`, 'i').test(cleanTitleWithoutEp);
      }
      if (!matchesSeason) return null;
    }
  }

  // ---- Relation exclusion (with token-level check) ----
  const releaseTokens = releaseTitle.split(/\s+/);
  for (const forb of forbiddenTitles) {
    const forbRegex = new RegExp('\\b' + escapeRegex(forb) + '\\b', 'i');
    if (forbRegex.test(releaseTitle) && !mediaTitles.some(mt => new RegExp('\\b' + escapeRegex(mt) + '\\b', 'i').test(mt))) {
      return null;
    }
    const forbTokens = forb.split(/\s+/);
    for (const token of forbTokens) {
      if (token.length > 3 && !mediaTitles.some(mt => mt.includes(token))) {
        if (releaseTokens.some(rt => rt.includes(token))) {
          return null;
        }
      }
    }
  }

  // ---- Hardcoded fallback for original Naruto ----
  if (media.episodeCount === 220 && media.title.toLowerCase().includes('naruto')) {
    const lowerRel = releaseTitle.toLowerCase();
    if (lowerRel.includes('shippuuden') || lowerRel.includes('shippuden') || lowerRel.includes('boruto') || lowerRel.includes('next generations')) {
      return null;
    }
  }

  let episodeStart = null, episodeEnd = null;
  const range = extractEpisodeRange(name);
  if (range) {
    episodeStart = range.start;
    episodeEnd = range.end;
  } else {
    const ep = parsed.episodeNumber;
    episodeStart = ep;
    episodeEnd = ep;
  }

  // Validate episode range against series episode count
  if (media.episodeCount && media.episodeCount > 0) {
    if (episodeStart !== null && episodeStart > media.episodeCount) return null;
    if (episodeEnd !== null && episodeEnd > media.episodeCount) return null;
  }

  const isBatch = isBatchRelease(name);

  let coverageType = 'unknown';
  let coveragePercent = 0;
  if (isBatch) {
    if (episodeStart !== null && episodeEnd !== null) {
      if (media.episodeCount && media.episodeCount > 0) {
        const total = media.episodeCount;
        coveragePercent = Math.min(100, Math.round(((episodeEnd - episodeStart + 1) / total) * 100));
        coverageType = coveragePercent >= 90 ? 'verified_complete' : 'partial';
      } else {
        coverageType = 'partial';
        coveragePercent = 50;
      }
    } else {
      coverageType = 'claimed_complete';
      coveragePercent = 100;
    }
  } else if (episodeStart !== null) {
    coverageType = 'single';
    coveragePercent = media.episodeCount ? Math.round((1 / media.episodeCount) * 100) : 0;
  }

  const qualityInfo = parseQuality(name);
  const sourceType = parseSource(name);
  const releaseGroup = parsed.releaseGroup || getReleaseGroup(name);
  const isTrusted = TRUSTED_GROUPS.some(g => releaseGroup && releaseGroup.toLowerCase().includes(g.toLowerCase()));

  let score = 0;
  if (coverageType === 'verified_complete') score += 40;
  else if (coverageType === 'claimed_complete') score += 30;
  else if (coverageType === 'partial') score += 20;
  else if (coverageType === 'single') score += 10;

  if (qualityInfo.quality >= 1080) score += 30;
  else if (qualityInfo.quality >= 720) score += 20;
  else if (qualityInfo.quality >= 480) score += 10;

  if (sourceType === 'bluray') score += 20;
  else if (sourceType === 'web-dl') score += 10;

  if (release.seeders > 100) score += 10;
  else if (release.seeders > 50) score += 5;

  if (isTrusted) score += 15;

  let confidence = 'medium';
  const exactTitleMatch = mediaTitles.some(mt => releaseTitle === mt);
  if (exactTitleMatch && isTrusted) confidence = 'high';
  else if (exactTitleMatch || isTrusted) confidence = 'high';

  return {
    ...release,
    episodeStart,
    episodeEnd,
    isBatch,
    quality: qualityInfo.quality,
    qualityLabel: qualityInfo.label,
    sourceType,
    coverageType,
    coveragePercent,
    confidence,
    releaseGroup,
    isTrusted,
    score: Math.min(score, 100)
  };
}

async function searchWithAggregation(media, sourceList, queryTiers, searchFnMap) {
  const tasks = [];
  for (const src of sourceList) {
    const searchFn = searchFnMap[src];
    if (!searchFn) continue;
    for (const tier of queryTiers) {
      for (const q of tier) {
        tasks.push(
          searchFn(q).catch(err => {
            console.warn(`Source ${src} query "${q}" failed:`, err.message);
            return [];
          })
        );
      }
    }
  }
  const resultsArray = await Promise.all(tasks);
  const rawResults = resultsArray.flat();
  const validated = rawResults
    .map(r => validateAndScoreRelease(r, media))
    .filter(r => r !== null);
  const hashMap = new Map();
  for (const r of validated) {
    const hash = extractMagnetHash(r.magnet) || normalizeTitle(r.name);
    if (!hashMap.has(hash) || r.score > hashMap.get(hash).score) {
      hashMap.set(hash, r);
    }
  }
  const deduped = Array.from(hashMap.values());
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

async function searchAnimeReleases(media) {
  const allTitles = [media.title, ...(media.aliases || [])].map(t => t.replace(/[:]/g, '').trim());
  const uniqueTitles = [...new Set(allTitles)].filter(Boolean);
  const primary = uniqueTitles[0] || media.title.replace(/[:]/g, '').trim();
  const baseTitle = stripSeasonInfo(primary);
  const others = uniqueTitles.slice(1);

  const mediaSeason = getMediaSeason(media);
  const seasonPad = String(mediaSeason).padStart(2, '0');
  const seasonQueries = mediaSeason > 1
    ? [`${baseTitle} S${seasonPad}`, `${baseTitle} Season ${mediaSeason}`]
    : [];

  const queryTiers = [
    [primary],
    others.length ? others : [],
    seasonQueries.length ? seasonQueries : [],
    [`${baseTitle} Batch`]
  ].filter(tier => tier.length > 0);

  const sourceList = ['nyaa_rss', 'torrentclaw'];
  const searchFnMap = {
    nyaa_rss: searchNyaaRSS,
    torrentclaw: searchTorrentClaw
  };
  return searchWithAggregation(media, sourceList, queryTiers, searchFnMap);
}

async function searchMovieReleases(media) {
  const allTitles = [media.title, ...(media.aliases || [])].map(t => t.replace(/[:]/g, '').trim());
  const uniqueTitles = [...new Set(allTitles)].filter(Boolean);
  const primary = uniqueTitles[0] || media.title.replace(/[:]/g, '').trim();
  const others = uniqueTitles.slice(1);
  const queryTiers = [
    [primary],
    others.length ? others : [],
    media.year ? [`${primary} ${media.year}`] : []
  ].filter(tier => tier.length > 0);
  const sourceList = ['yts', 'torrentclaw'];
  const searchFnMap = {
    yts: searchYTS,
    torrentclaw: searchTorrentClaw
  };
  return searchWithAggregation(media, sourceList, queryTiers, searchFnMap);
}

async function searchSeriesReleases(media) {
  const allTitles = [media.title, ...(media.aliases || [])].map(t => t.replace(/[:]/g, '').trim());
  const uniqueTitles = [...new Set(allTitles)].filter(Boolean);
  const primary = uniqueTitles[0] || media.title.replace(/[:]/g, '').trim();
  const baseTitle = stripSeasonInfo(primary);
  const others = uniqueTitles.slice(1);

  const mediaSeason = getMediaSeason(media);
  const seasonPad = String(mediaSeason).padStart(2, '0');

  const queryTiers = [
    [primary],
    others.length ? others : [],
    [`${baseTitle} S${seasonPad}`, `${baseTitle} Season ${mediaSeason}`, `${baseTitle} Complete Season`],
    media.year ? [`${baseTitle} ${media.year}`] : []
  ].filter(tier => tier.length > 0);

  const sourceList = ['eztv', 'torrentclaw'];
  const searchFnMap = {
    eztv: searchEZTV,
    torrentclaw: searchTorrentClaw
  };
  return searchWithAggregation(media, sourceList, queryTiers, searchFnMap);
}

async function searchReleases(media) {
  const category = getCategory(media.category);
  if (!category || !category.adapter) return [];
  if (category.adapter === 'anime') return searchAnimeReleases(media);
  if (category.adapter === 'movie') return searchMovieReleases(media);
  if (category.adapter === 'series') return searchSeriesReleases(media);
  return [];
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
    for (const catId of categories) {
      const config = getCategory(catId);
      if (!config) continue;
      if (config.metadataProvider === 'anilist') {
        const query = `
          query($search: String, $type: MediaType, $page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
              pageInfo { hasNextPage }
              media(search: $search, type: $type) {
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
          }
        `;
        const type = 'ANIME';
        const variables = { search: q, type, page, perPage };
        const data = await fetchAniList(query, variables);
        const items = (data.Page.media || []).map(item => {
          const relations = (item.relations?.edges || []).map(e => ({
            id: e.node.id,
            title: e.node.title?.romaji || e.node.title?.english || e.node.title?.native || '',
            relationType: e.relationType,
            format: e.node.format
          }));
          const media = normalizeAniListMedia(item, catId, relations);
          return mediaToCard(media);
        });
        allResults.push(...items);
      } else if (config.metadataProvider === 'tmdb' && TMDB_API_KEY) {
        const mediaType = config.mediaType === 'movie' ? 'movie' : 'tv';
        let params = { query: q, page };
        if (catId === 'hollywood') {
          params.region = 'US';
        } else if (catId === 'bollywood') {
          params.region = 'IN';
        }
        const url = new URL(`https://api.themoviedb.org/3/search/${mediaType}`);
        url.searchParams.set('api_key', TMDB_API_KEY);
        url.searchParams.set('language', 'en-US');
        for (const [key, val] of Object.entries(params)) {
          if (val !== undefined && val !== null && val !== '') url.searchParams.set(key, val);
        }
        const apiRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (apiRes.ok) {
          const data = await apiRes.json();
          let results = data.results || [];
          
          if (catId === 'bollywood') {
            results = results.filter(item => item.original_language === 'hi');
          } else if (catId === 'asian') {
            results = results.filter(item => ['ja', 'ko', 'zh'].includes(item.original_language));
          } else if (catId === 'animation') {
            results = results.filter(item => item.genre_ids?.includes(16));
          } else if (catId === 'tokusatsu') {
            results = results.filter(item => item.original_language === 'ja');
          }

          const items = results.map(item => {
            const media = normalizeTmdbMedia(item, catId);
            return mediaToCard(media);
          });
          allResults.push(...items);
        }
      }
    }
    const seen = new Set();
    const unique = allResults.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    res.json({
      query: q,
      category: categoryId,
      page,
      perPage,
      total: unique.length,
      items: unique
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
    // Quality filter removed – we ignore the parameter
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
      const provider = mediaId.startsWith('anilist') ? 'anilist' : 'tmdb';
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
        if (rawMedia) {
          mediaObject = normalizeAniListMedia(rawMedia, categoryId, relations);
        }
      } else if (provider === 'tmdb') {
        const mediaType = config.mediaType === 'movie' ? 'movie' : 'tv';
        const url = `https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const apiRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (apiRes.ok) {
          const data = await apiRes.json();
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
    // No quality filtering – we return all releases sorted by score
    const highConfidence = releases.filter(r => r.confidence === 'high');
    const medConfidence = releases.filter(r => r.confidence === 'medium');
    const lowConfidence = releases.filter(r => r.confidence === 'low');
    const total = releases.length;
    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);
    const paginated = releases.slice(start, end);
    const best = highConfidence.length > 0 ? highConfidence[0] :
                 medConfidence.length > 0 ? medConfidence[0] :
                 lowConfidence.length > 0 ? lowConfidence[0] : null;
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
        description: best.coverageType === 'verified_complete' ? 'Complete series (verified)' :
                    best.coverageType === 'claimed_complete' ? 'Complete series (claimed)' :
                    best.coverageType === 'partial' ? `Episodes ${best.episodeStart}-${best.episodeEnd} (${best.coveragePercent}%)` :
                    best.coverageType === 'single' ? `Episode ${best.episodeStart}` :
                    best.coverageType === 'collection' ? 'Collection (unverified)' :
                    'Unknown coverage',
        score: best.score,
        confidence: best.confidence,
        releaseGroup: best.releaseGroup,
        isTrusted: best.isTrusted
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
        description: r.coverageType === 'verified_complete' ? 'Complete series (verified)' :
                    r.coverageType === 'claimed_complete' ? 'Complete series (claimed)' :
                    r.coverageType === 'partial' ? `Episodes ${r.episodeStart}-${r.episodeEnd} (${r.coveragePercent}%)` :
                    r.coverageType === 'single' ? `Episode ${r.episodeStart}` :
                    r.coverageType === 'collection' ? 'Collection (unverified)' :
                    'Unknown coverage',
        score: r.score,
        confidence: r.confidence,
        releaseGroup: r.releaseGroup,
        isTrusted: r.isTrusted
      })),
      hasMore: end < total,
      lowConfidenceCount: lowConfidence.length
    });
  } catch (err) {
    console.error('Releases error:', err);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

app.post('/api/recommendations', async (req, res) => {
  res.json({ items: [] });
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
  const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
  if (!apiRes.ok) throw new Error(`Groq API error: ${apiRes.status}`);
  const data = await apiRes.json();
  return JSON.parse(data.choices[0].message.content);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/', (req, res) => res.send('KITO API running.'));
app.listen(PORT, () => console.log(`KITO backend on port ${PORT}`));