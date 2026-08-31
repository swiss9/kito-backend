const xml2js = require('xml2js');
const { TORRENTCLAW_API_KEY } = require('../config');
const { getCache, setCache, deleteCache } = require('../services/cacheService');
const { normalizeTitle, extractMagnetHash, stripSeasonInfo } = require('../utils');
const { processRelease, getMediaSeason } = require('./rankingService');
const { httpGet } = require('./httpClient');
const rootLogger = require('./logger');

const STOP_WORDS_QUERY = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'no', 'na']);

function generateQueryTiers(media, logger) {
  const log = logger || rootLogger;
  const titles = [media.title, ...(media.aliases || [])]
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

  const aliasMap = {
    'zeztz': ['zeztz', 'Zeztz', 'Kamen Rider Zeztz', 'zeztz ep', 'zeztz episode', 'Zeztz EP49', 'zeztz 49', 'Zeztz 49', 'Kamen Rider Zeztz 49'],
    'fourze': ['fourze', 'Fourze', 'Kamen Rider Fourze', 'fourze ep', 'fourze episode'],
    'ooo': ['ooo', 'ozu', 'OOO', 'Ozu', 'Kamen Rider OOO', 'Kamen Rider Ozu'],
    '555': ['555', 'faiz', 'Faiz', 'Kamen Rider 555', 'Kamen Rider Faiz']
  };

  const lowerTitle = media.title.toLowerCase();
  for (const [key, aliases] of Object.entries(aliasMap)) {
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

  const reducedTiers = dedupedTiers.slice(0, 8);

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
  const baseUrl = 'https://torrentclaw.com/api/search';
  const params = new URLSearchParams({ q: title, category: 'all', limit: 100 });
  if (TORRENTCLAW_API_KEY) params.append('apikey', TORRENTCLAW_API_KEY);
  const url = `${baseUrl}?${params.toString()}`;
  const cacheKey = `torrentclaw:${url}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const res = await httpGet(url);
  const data = await res.json();
  const results = (data.results || data || []).map(t => ({
    name: t.name || t.title || 'Unknown',
    magnet: t.magnet || t.magnetLink || '',
    size: t.size || '',
    seeders: t.seeders || 0,
    leechers: t.leechers || 0,
    uploader: t.uploader || t.uploaderName || t.username || ''
  }));
  rootLogger.debug(`[torrentclaw] query "${title}" -> ${results.length} results`);
  await setCache(cacheKey, results, 3600);
  return results;
}

const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

async function searchNyaaRSS(title, category = 'anime', force = false) {
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

  await new Promise(resolve => setTimeout(resolve, 1200));

  const urlWithBust = `${baseUrl}&_=${Date.now()}`;
  rootLogger.debug(`[nyaa] fetching fresh for "${title}" (${category})`);
  const res = await httpGet(urlWithBust, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const text = await res.text();
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(text);
  const items = result.rss?.channel?.item;
  const itemArray = items ? (Array.isArray(items) ? items : [items]) : [];
  rootLogger.debug(`[nyaa] query "${title}" (${category}) -> ${itemArray.length} items`);

  const results = itemArray.map(item => {
    const title = item.title || 'Unknown';
    const infoHash = item['nyaa:infoHash'] || '';
    const magnet = infoHash
      ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}${ANIME_TRACKERS}`
      : (item.link || '');
    return {
      name: title,
      magnet,
      size: item['nyaa:size'] || '',
      seeders: parseInt(item['nyaa:seeders']) || 0,
      leechers: parseInt(item['nyaa:leechers']) || 0,
      uploader: ''
    };
  });
  await setCache(cacheKey, results, 1800);
  return results;
}

async function searchAnimeGarden(title) {
  const url = `https://api.animes.garden/resources?search=${encodeURIComponent(title)}`;
  const cacheKey = `animegarden:${url}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    rootLogger.debug(`[animegarden] cache HIT for "${title}" -> ${cached.length} results`);
    return cached;
  }

  const res = await httpGet(url);
  const data = await res.json();
  const results = (data.results || data || []).map(r => ({
    name: r.title || r.name || 'Unknown',
    magnet: r.magnet || '',
    size: r.size || '',
    seeders: r.seeders || 0,
    leechers: r.leechers || 0,
    uploader: r.publisher || r.uploader || ''
  }));
  rootLogger.debug(`[animegarden] query "${title}" -> ${results.length} results`);
  await setCache(cacheKey, results, 1800);
  return results;
}

async function searchWithAggregation(media, sourceList, queryTiers, searchFnMap, force = false, logger) {
  const log = logger || rootLogger;
  const allResults = [];

  for (const src of sourceList) {
    const searchFn = searchFnMap[src];
    if (!searchFn) continue;

    const queries = [...new Set(queryTiers.flat().filter(Boolean))];
    log.debug(`[searchWithAggregation] Source "${src}" will run ${queries.length} unique queries (force=${force})`);
    queries.forEach((q, i) => log.debug(`  ${i + 1}. "${q}"`));

    const srcResults = await Promise.allSettled(
      queries.map(q => searchFn(q, force).catch(err => { log.warn(`Source ${src} query "${q}" failed:`, err.message); return []; }))
    );
    for (const result of srcResults) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      }
    }
  }

  log.debug(`[aggregate] raw results for "${media.title}": ${allResults.length}`);

  const validated = allResults
    .map(r => processRelease(r, media))
    .filter(r => r !== null);

  log.debug(`[aggregate] validated results for "${media.title}": ${validated.length}`);

  const hashMap = new Map();
  for (const r of validated) {
    const hash = extractMagnetHash(r.magnet) || `${normalizeTitle(r.name)}|${r.size}`;
    if (!hashMap.has(hash) || r.score > hashMap.get(hash).score) {
      hashMap.set(hash, r);
    }
  }
  const deduped = Array.from(hashMap.values());
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

async function searchAnimeReleases(media, force = false, logger) {
  const log = logger || rootLogger;
  const queryTiers = generateQueryTiers(media, log);

  const nyaaSearch = async (title, forceSearch = false) => {
    const forceFlag = forceSearch || force;
    if (media.category === 'tokusatsu') {
      const primaryResults = await searchNyaaRSS(title, 'tokusatsu', forceFlag);
      const hasGood = primaryResults.some(r => (r.seeders || 0) >= 5);
      if (!hasGood && primaryResults.length < 3) {
        const fallbackResults = await searchNyaaRSS(title, 'anime', forceFlag);
        return [...primaryResults, ...fallbackResults];
      }
      return primaryResults;
    }
    return searchNyaaRSS(title, 'anime', forceFlag);
  };

  const sourceList = ['nyaa_rss'];
  const searchFnMap = { nyaa_rss: nyaaSearch };
  return searchWithAggregation(media, sourceList, queryTiers, searchFnMap, force, log);
}

async function searchReleases(media, force = false) {
  const { categoryConfig } = require('../config');
  const category = categoryConfig[media.category];
  if (!category) return [];
  if (category.id === 'anime' || category.id === 'tokusatsu') {
    return searchAnimeReleases(media, force);
  }
  return [];
}

function mergeReleases(primary, fallback) {
  const combined = [...primary, ...fallback];
  const hashMap = new Map();
  for (const r of combined) {
    const hash = extractMagnetHash(r.magnet) || `${normalizeTitle(r.name)}|${r.size}`;
    if (!hashMap.has(hash) || r.score > hashMap.get(hash).score) {
      hashMap.set(hash, r);
    }
  }
  const deduped = Array.from(hashMap.values());
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

async function searchReleasesWithFallback(media, force = false, logger = null) {
  const log = logger || rootLogger;
  const categoryId = media.category;
  let allRawResults = [];

  const nyaaResults = await searchAnimeReleases(media, force, log);
  allRawResults = allRawResults.concat(nyaaResults);

  if (nyaaResults.length < 3) {
    try {
      let gardenRaw = [];
      let clawRaw = [];
      if (categoryId === 'anime') {
        gardenRaw = await searchAnimeGarden(media.title);
        clawRaw = await searchTorrentClaw(media.title);
      } else if (categoryId === 'tokusatsu') {
        gardenRaw = await searchAnimeGarden(media.title);
        clawRaw = await searchTorrentClaw(media.title);
      }
      const gardenProcessed = gardenRaw.map(r => processRelease(r, media)).filter(r => r !== null);
      const clawProcessed = clawRaw.map(r => processRelease(r, media)).filter(r => r !== null);
      allRawResults = allRawResults.concat(gardenProcessed, clawProcessed);
    } catch (err) {
      log.warn(`Fallback sources failed: ${err.message}`);
    }
  }

  const merged = mergeReleases(allRawResults, []);
  log.debug(`[final] "${media.title}" -> total unique releases: ${merged.length}`);
  return merged;
}

module.exports = {
  searchTorrentClaw,
  searchNyaaRSS,
  searchAnimeGarden,
  searchWithAggregation,
  searchAnimeReleases,
  searchReleases,
  searchReleasesWithFallback
};
