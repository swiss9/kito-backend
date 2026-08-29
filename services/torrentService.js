const xml2js = require('xml2js');
const { TORRENTCLAW_API_KEY } = require('../config');
const { getCache, setCache } = require('../services/cacheService');
const { normalizeTitle, extractMagnetHash, stripSeasonInfo } = require('../utils');
const { processRelease, getMediaSeason } = require('./rankingService');
const { httpGet } = require('./httpClient');

const STOP_WORDS_QUERY = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'no', 'na']);

function generateQueryTiers(media) {
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
    'zeztz': ['zeztz', 'zeztz ep', 'zeztz episode', 'kamen rider zeztz', 'zeztz 49', 'zeztz 48'],
    'fourze': ['fourze', 'fourze ep', 'fourze episode', 'kamen rider fourze'],
    'ooo': ['ooo', 'ozu', 'ooo ep', 'kamen rider ooo', 'kamen rider ozu'],
    '555': ['555', 'faiz', '555 ep', 'kamen rider 555', 'kamen rider faiz']
  };

  const lowerTitle = media.title.toLowerCase();
  for (const [key, aliases] of Object.entries(aliasMap)) {
    if (lowerTitle.includes(key)) {
      for (const alias of aliases) {
        tiers.push([alias]);
      }
    }
  }

  console.log(`[generateQueryTiers] Media: "${media.title}" (${media.category})`);
  console.log(`[generateQueryTiers] Tiers:`);
  tiers.forEach((tier, idx) => {
    console.log(`  Tier ${idx + 1}: ${JSON.stringify(tier)}`);
  });
  console.log(`[generateQueryTiers] Flattened unique queries: ${JSON.stringify([...new Set(tiers.flat())])}`);

  return tiers;
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
  console.log(`[torrentclaw] query "${title}" -> ${results.length} results`);
  await setCache(cacheKey, results, 3600);
  return results;
}

const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

async function searchNyaaRSS(title, category = 'anime') {
  let catParam = '1_2';
  if (category === 'tokusatsu') {
    catParam = '4_1';
  }
  const baseUrl = `https://nyaa.si/?page=rss&c=${catParam}&q=${encodeURIComponent(title)}`;
  const urlWithBust = `${baseUrl}&_=${Date.now()}`;
  const cacheKey = `nyaa:${baseUrl}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`[nyaa] cache HIT for "${title}" (${category}) -> ${cached.length} results`);
    return cached;
  }

  const res = await httpGet(urlWithBust, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const text = await res.text();
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(text);
  const items = result.rss?.channel?.item;
  const itemArray = items ? (Array.isArray(items) ? items : [items]) : [];
  console.log(`[nyaa] query "${title}" (${category}) -> ${itemArray.length} items`);

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
    console.log(`[animegarden] cache HIT for "${title}" -> ${cached.length} results`);
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
  console.log(`[animegarden] query "${title}" -> ${results.length} results`);
  await setCache(cacheKey, results, 1800);
  return results;
}

async function searchWithAggregation(media, sourceList, queryTiers, searchFnMap) {
  const allResults = [];

  for (const src of sourceList) {
    const searchFn = searchFnMap[src];
    if (!searchFn) continue;

    const queries = [...new Set(queryTiers.flat().filter(Boolean))];
    console.log(`[searchWithAggregation] Source "${src}" will run ${queries.length} unique queries:`);
    queries.forEach((q, i) => console.log(`  ${i + 1}. "${q}"`));

    const srcResults = await Promise.allSettled(
      queries.map(q => searchFn(q).catch(err => { console.warn(`Source ${src} query "${q}" failed:`, err.message); return []; }))
    );
    for (const result of srcResults) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      }
    }
  }

  console.log(`[aggregate] raw results for "${media.title}": ${allResults.length}`);

  const validated = allResults
    .map(r => processRelease(r, media))
    .filter(r => r !== null);

  console.log(`[aggregate] validated results for "${media.title}": ${validated.length}`);

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

async function searchAnimeReleases(media) {
  const queryTiers = generateQueryTiers(media);

  const nyaaSearch = async (title) => {
    if (media.category === 'tokusatsu') {
      const primaryResults = await searchNyaaRSS(title, 'tokusatsu');
      const hasGood = primaryResults.some(r => (r.seeders || 0) >= 5);
      if (!hasGood && primaryResults.length < 3) {
        const fallbackResults = await searchNyaaRSS(title, 'anime');
        return [...primaryResults, ...fallbackResults];
      }
      return primaryResults;
    }
    return searchNyaaRSS(title, 'anime');
  };

  const sourceList = ['nyaa_rss'];
  const searchFnMap = { nyaa_rss: nyaaSearch };
  return searchWithAggregation(media, sourceList, queryTiers, searchFnMap);
}

async function searchReleases(media) {
  const { categoryConfig } = require('../config');
  const category = categoryConfig[media.category];
  if (!category) return [];
  if (category.id === 'anime' || category.id === 'tokusatsu') {
    return searchAnimeReleases(media);
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

async function searchReleasesWithFallback(media) {
  const categoryId = media.category;
  let primaryResults = [];
  let fallbackResults = [];

  primaryResults = await searchAnimeReleases(media);

  const hasGoodRelease = primaryResults.some(r => (r.seeders || 0) >= 5);

  if (!hasGoodRelease) {
    try {
      if (categoryId === 'anime') {
        const gardenRaw = await searchAnimeGarden(media.title);
        fallbackResults = gardenRaw.map(r => processRelease(r, media)).filter(r => r !== null);
        if (fallbackResults.length === 0) {
          const clawRaw = await searchTorrentClaw(media.title);
          fallbackResults = clawRaw.map(r => processRelease(r, media)).filter(r => r !== null);
        }
      } else if (categoryId === 'tokusatsu') {
        const raw = await searchTorrentClaw(media.title);
        fallbackResults = raw.map(r => processRelease(r, media)).filter(r => r !== null);
      }
    } catch (err) {
      console.warn(`Fallback search failed:`, err.message);
    }
  }

  const merged = mergeReleases(primaryResults, fallbackResults);
  console.log(`[final] "${media.title}" -> primary: ${primaryResults.length}, fallback: ${fallbackResults.length}, total: ${merged.length}`);
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
