const { TORRENTCLAW_API_KEY, ALIAS_MAP, TOKUSATSU_FRANCHISES } = require('../config');
const { getCache, setCache, deleteCache } = require('../services/cacheService');
const { normalizeTitle, extractMagnetHash, stripSeasonInfo } = require('../utils');
const { isReleaseValid } = require('./releaseRankingService');
const { httpGet } = require('./httpClient');
const rootLogger = require('./logger');
const { XMLParser } = require('fast-xml-parser');

const STOP_WORDS_QUERY = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'no', 'na']);

function generateQueryTiers(media, logger) {
  const log = logger || rootLogger;
  const titles = [media.title, ...(media.aliases || [])]
    .filter(t => typeof t === 'string' && t.length > 0)
    .map(t => t.replace(/[:/]/g, ' ').replace(/[^\w\s]/g, '').trim())
    .filter(Boolean);

  const uniqueTitles = [...new Set(titles)];
  const tiers = [];

  for (const title of uniqueTitles) {
    const cleaned = title.replace(/\s+/g, ' ').trim();
    if (cleaned) tiers.push([cleaned]);

    const withoutStop = cleaned.split(' ').filter(w => !STOP_WORDS_QUERY.has(w.toLowerCase())).join(' ');
    if (withoutStop && withoutStop !== cleaned) tiers.push([withoutStop]);

    const words = cleaned.split(' ');
    if (words.length > 1) {
      tiers.push([words[0]]);
      if (words.length > 2) {
        tiers.push([words.slice(0, 2).join(' ')]);
      }
    }

    const colonParts = media.title.split(':');
    if (colonParts.length > 1) {
      const firstPart = colonParts[0].trim();
      if (firstPart && firstPart !== cleaned) tiers.push([firstPart]);
    }
  }

  const franchise = extractFranchiseTitle(media.title);
  if (franchise && !uniqueTitles.includes(franchise)) {
    tiers.push([franchise]);
    tiers.push([`${franchise} Batch`]);
  }

  if (media.category === 'tokusatsu') {
    const batchVariants = [
      `${media.title} Complete`,
      `${media.title} Complete Series`,
      `${media.title} Complete Batch`
    ];
    if (media.title !== franchise) {
      batchVariants.push(`${franchise} Complete`);
      batchVariants.push(`${franchise} Complete Series`);
      batchVariants.push(`${franchise} Complete Batch`);
    }
    tiers.push(batchVariants);
  }

  const lowerTitle = media.title.toLowerCase();
  for (const [key, aliases] of Object.entries(ALIAS_MAP)) {
    if (lowerTitle.includes(key)) {
      for (const alias of aliases) {
        tiers.push([alias]);
      }
    }
  }

  const dedupedTiers = [];
  const seen = new Set();
  for (const tier of tiers) {
    for (const q of tier) {
      if (!seen.has(q.toLowerCase())) {
        seen.add(q.toLowerCase());
        dedupedTiers.push([q]);
      }
    }
  }

  const reducedTiers = dedupedTiers.slice(0, 5);

  log.debug(`[generateQueryTiers] Media: "${media.title}" (${media.category})`);
  log.debug(`[generateQueryTiers] Tiers (reduced to ${reducedTiers.length}):`);
  reducedTiers.forEach((tier, idx) => {
    log.debug(`  Tier ${idx + 1}: ${JSON.stringify(tier)}`);
  });

  return reducedTiers;
}

function extractFranchiseTitle(title) {
  const parts = title.split(/[-:/]/);
  if (parts.length === 0) return stripSeasonInfo(title);
  return stripSeasonInfo(parts[0].trim());
}

async function searchTorrentClaw(title) {
  const baseUrl = 'https://torrentclaw.com/api/v1/search';
  const params = new URLSearchParams({ q: title, category: 'all', limit: 100 });
  if (TORRENTCLAW_API_KEY) params.append('apikey', TORRENTCLAW_API_KEY);
  const url = `${baseUrl}?${params.toString()}`;
  const cacheKey = `torrentclaw:${url}`;

  const cached = await getCache(cacheKey);
  if (cached) {
    rootLogger.debug(`[torrentclaw] cache HIT for "${title}" -> ${cached.length} results`);
    return cached;
  }

  try {
    const res = await httpGet(url, { timeoutMs: 5000, maxRetries: 1 });
    if (res.status === 404) {
      rootLogger.warn(`[torrentclaw] 404 for "${title}" â€“ skipping retries`);
      return [];
    }
    const data = await res.json();
    let rawResults = [];
    if (data && typeof data === 'object') {
      if (Array.isArray(data.results)) rawResults = data.results;
      else if (Array.isArray(data.data)) rawResults = data.data;
      else if (Array.isArray(data)) rawResults = data;
    }
    const mapped = rawResults.map(t => ({
      name: t.name || t.title || 'Unknown',
      magnet: t.magnet || t.magnetLink || '',
      size: t.size || '',
      seeders: t.seeders || 0,
      leechers: t.leechers || 0,
      uploader: t.uploader || t.uploaderName || t.username || ''
    }));
    rootLogger.debug(`[torrentclaw] query "${title}" -> ${mapped.length} results`);
    await setCache(cacheKey, mapped, 3600);
    return mapped;
  } catch (err) {
    rootLogger.warn({ err, title }, 'TorrentClaw search failed');
    return [];
  }
}

const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

function parseNyaaRSS(text) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: false,
    parseTagValue: false,
    parseAttributeValue: false
  });
  const parsed = parser.parse(text);
  const items = parsed?.rss?.channel?.item;
  const itemArray = items ? (Array.isArray(items) ? items : [items]) : [];
  return itemArray.map(item => ({
    title: item.title || 'Unknown',
    link: item.link || '',
    infoHash: item['nyaa:infoHash'] || '',
    size: item['nyaa:size'] || '',
    seeders: Number(item['nyaa:seeders']) || 0,
    leechers: Number(item['nyaa:leechers']) || 0
  }));
}

async function searchNyaaRSSWithRetry(title, category = 'anime', force = false, retries = 1) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await searchNyaaRSS(title, category, force);
    } catch (err) {
      lastError = err;
      if (err.status === 429) {
        await setCache('nyaa_rate_limited', true, 300);
        rootLogger.warn(`[nyaa] Rate limit hit for "${title}". Aborting retries to prevent timeout.`);
        break;
      }
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 2000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function searchNyaaRSS(title, category = 'anime', force = false) {
  const rateLimited = await getCache('nyaa_rate_limited');
  if (rateLimited) {
    const err = new Error('Nyaa rate limited');
    err.status = 429;
    throw err;
  }

  let catParam = '1_2';
  if (category === 'tokusatsu') {
    catParam = '4_1';
  }
  const baseUrl = `https://nyaa.si/?page=rss&c=${catParam}&q=${encodeURIComponent(title)}`;
  const cacheKey = `nyaa:${baseUrl}`;

  if (force) {
    rootLogger.debug(`[nyaa] force delete cache for "${title}" (${category})`);
    await deleteCache(cacheKey);
  } else {
    const cached = await getCache(cacheKey);
    if (cached) {
      rootLogger.debug(`[nyaa] cache HIT for "${title}" (${category}) -> ${cached.length} results`);
      return cached;
    }
  }

  const urlWithBust = `${baseUrl}&_=${Date.now()}`;
  rootLogger.debug(`[nyaa] fetching fresh for "${title}" (${category})`);
  const res = await httpGet(urlWithBust, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeoutMs: 5000,
    maxRetries: 0
  });

  if (res.status === 429) {
    const err = new Error(`Nyaa rate limit (429) for "${title}"`);
    err.status = 429;
    throw err;
  }

  const text = await res.text();
  const parsedItems = parseNyaaRSS(text);
  rootLogger.debug(`[nyaa] query "${title}" (${category}) -> ${parsedItems.length} items`);

  const results = parsedItems.map(item => {
    const magnet = item.infoHash
      ? `magnet:?xt=urn:btih:${item.infoHash}&dn=${encodeURIComponent(item.title)}${ANIME_TRACKERS}`
      : (item.link || '');
    return {
      name: item.title,
      magnet,
      size: item.size,
      seeders: item.seeders,
      leechers: item.leechers,
      uploader: ''
    };
  });
  await setCache(cacheKey, results, 43200);
  return results;
}

function deduplicateRawReleases(releases) {
  const map = new Map();
  for (const r of releases) {
    const hash = extractMagnetHash(r.magnet) || `${normalizeTitle(r.name)}|${r.size}`;
    if (!map.has(hash)) {
      map.set(hash, r);
    }
  }
  return Array.from(map.values());
}

async function searchWithAggregation(media, sourceList, queryTiers, searchFnMap, force = false, logger) {
  const log = logger || rootLogger;
  const rawResults = [];
  let rateLimited = false;

  for (const src of sourceList) {
    const searchFn = searchFnMap[src];
    if (!searchFn) continue;

    const queries = [...new Set(queryTiers.flat().filter(Boolean))];
    log.debug(`[searchWithAggregation] Source "${src}" will run up to ${queries.length} queries with early stopping`);

    let validCount = 0;
    let hasGoodSeeders = false;

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        const res = await searchFn(q, force);
        if (Array.isArray(res)) {
          for (const r of res) {
            if (isReleaseValid(r, media)) {
              validCount++;
              if ((r.seeders || 0) >= 10) hasGoodSeeders = true;
            }
            rawResults.push(r);
          }
        }
      } catch (err) {
        if (err.status === 429) {
          rateLimited = true;
          log.warn(`Source ${src} query "${q}" rate limited, stopping further queries`);
          break;
        }
        log.warn(`Source ${src} query "${q}" failed:`, err.message);
      }

      if (validCount >= 3 && hasGoodSeeders) {
        log.info(`[searchWithAggregation] Found good releases early. Skipping remaining ${queries.length - (i + 1)} queries.`);
        break;
      }
    }
  }

  log.debug(`[aggregate] raw results for "${media.title}": ${rawResults.length} (rateLimited: ${rateLimited})`);

  return { results: deduplicateRawReleases(rawResults), rateLimited };
}

async function searchAnimeReleases(media, force = false, logger) {
  const log = logger || rootLogger;
  const queryTiers = generateQueryTiers(media, log);

  const nyaaSearch = async (title, forceSearch = false) => {
    const forceFlag = forceSearch || force;
    try {
      if (media.category === 'tokusatsu') {
        const primaryResults = await searchNyaaRSSWithRetry(title, 'tokusatsu', forceFlag);
        const hasGood = primaryResults.some(r => (r.seeders || 0) >= 5);
        if (!hasGood && primaryResults.length < 3) {
          const fallbackResults = await searchNyaaRSSWithRetry(title, 'anime', forceFlag);
          return [...primaryResults, ...fallbackResults];
        }
        return primaryResults;
      }
      return await searchNyaaRSSWithRetry(title, 'anime', forceFlag);
    } catch (err) {
      if (err.status === 429) {
        throw err;
      }
      log.warn(`Nyaa search for "${title}" failed:`, err.message);
      return [];
    }
  };

  const sourceList = ['nyaa_rss'];
  const searchFnMap = { nyaa_rss: nyaaSearch };

  let aggregationResult = await searchWithAggregation(media, sourceList, queryTiers, searchFnMap, force, log);
  let results = aggregationResult.results;
  let rateLimited = aggregationResult.rateLimited;

  if (media.category === 'anime') {
    const titleLower = media.title.toLowerCase();
    const isTokusatsuFranchise = TOKUSATSU_FRANCHISES.some(f => titleLower.includes(f));
    if (isTokusatsuFranchise) {
      log.info({ title: media.title }, 'Anime-tagged media matches tokusatsu franchise, also searching tokusatsu category');
      const tokusatsuMedia = { ...media, category: 'tokusatsu' };
      const tokusatsuTiers = generateQueryTiers(tokusatsuMedia, log);
      const tokusatsuAggregation = await searchWithAggregation(tokusatsuMedia, sourceList, tokusatsuTiers, searchFnMap, force, log);
      if (tokusatsuAggregation.results.length) {
        results = [...results, ...tokusatsuAggregation.results];
      }
      if (tokusatsuAggregation.rateLimited) rateLimited = true;
    }
  }

  return { results: deduplicateRawReleases(results), rateLimited };
}

async function searchReleases(media, force = false) {
  const { categoryConfig } = require('../config');
  const category = categoryConfig[media.category];
  if (!category) return { results: [], rateLimited: false };
  if (category.id === 'anime' || category.id === 'tokusatsu') {
    return searchAnimeReleases(media, force);
  }
  return { results: [], rateLimited: false };
}

async function searchReleasesWithFallback(media, force = false, logger = null) {
  const log = logger || rootLogger;
  const categoryId = media.category;
  let allRawResults = [];
  let rateLimited = false;
  const warnings = [];

  log.info({ title: media.title, category: categoryId, force }, 'Starting torrent search');

  const nyaaResult = await searchAnimeReleases(media, force, log);
  const nyaaResults = nyaaResult.results;
  rateLimited = nyaaResult.rateLimited;
  log.info({ source: 'nyaa', count: nyaaResults.length, rateLimited }, 'Nyaa search completed');
  allRawResults = allRawResults.concat(nyaaResults);

  if (rateLimited) {
    warnings.push('Nyaa.si is rate limited. Results may be incomplete.');
  }

  const isMovie = media.mediaType === 'movie' || media.episodeCount === 1;
  const hasCompleteRelease = isMovie
    ? (nyaaResults.length > 0)
    : nyaaResults.some(r => isReleaseValid(r, media) && r.name.match(/complete|batch/i));
  const shouldFallback = (nyaaResults.length === 0) || !hasCompleteRelease;

  if (shouldFallback) {
    log.info('Nyaa returned no complete release, trying fallback sources');
    try {
      let clawRaw = [];
      if (categoryId === 'anime' || categoryId === 'tokusatsu') {
        clawRaw = await searchTorrentClaw(media.title);
      }
      const clawValid = clawRaw.filter(r => isReleaseValid(r, media));
      log.info({ source: 'torrentclaw', count: clawValid.length }, 'TorrentClaw fallback completed');
      allRawResults = allRawResults.concat(clawValid);
    } catch (err) {
      log.warn({ err }, 'Fallback sources failed');
      warnings.push('Fallback sources failed.');
    }
  } else {
    log.info('Nyaa returned complete release, skipping fallback');
  }

  const merged = deduplicateRawReleases(allRawResults);
  log.info({ title: media.title, total: merged.length, warnings }, 'Torrent search finalised');
  return { releases: merged, warnings, rateLimited };
}

module.exports = {
  searchTorrentClaw,
  searchNyaaRSS,
  searchNyaaRSSWithRetry,
  searchWithAggregation,
  searchAnimeReleases,
  searchReleases,
  searchReleasesWithFallback
};
