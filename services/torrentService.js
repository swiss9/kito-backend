const xml2js = require('xml2js');
const { TORRENTCLAW_API_KEY } = require('../config');
const { setCache, getCached, normalizeTitle, extractMagnetHash, stripSeasonInfo } = require('../utils');
const { processRelease, getMediaSeason } = require('./rankingService');
const { httpGet } = require('./httpClient');

async function searchTorrentClaw(title) {
  const baseUrl = 'https://torrentclaw.com/api/search';
  const params = new URLSearchParams({ q: title, category: 'all', limit: 100 });
  if (TORRENTCLAW_API_KEY) params.append('apikey', TORRENTCLAW_API_KEY);
  const url = `${baseUrl}?${params.toString()}`;
  const cacheKey = `torrentclaw:${url}`;
  const cached = await getCached(cacheKey);
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
  await setCache(cacheKey, results, 1800);
  return results;
}

const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

async function searchNyaaRSS(title) {
  const url = `https://nyaa.si/?page=rss&c=1_2&q=${encodeURIComponent(title)}`;
  const cacheKey = `nyaa:${url}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await httpGet(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const text = await res.text();
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(text);
  const items = result.rss?.channel?.item;
  const itemArray = items ? (Array.isArray(items) ? items : [items]) : [];
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
  const cached = await getCached(cacheKey);
  if (cached) return cached;

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
  await setCache(cacheKey, results, 1800);
  return results;
}

// Removed searchYTS and searchEZTV entirely.

async function searchWithAggregation(media, sourceList, queryTiers, searchFnMap) {
  const allResults = [];

  for (const src of sourceList) {
    const searchFn = searchFnMap[src];
    if (!searchFn) continue;

    const queries = [...new Set(queryTiers.flat().filter(Boolean))];

    const srcResults = await Promise.allSettled(
      queries.map(q => searchFn(q).catch(err => { console.warn(`Source ${src} query "${q}" failed:`, err.message); return []; }))
    );
    for (const result of srcResults) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      }
    }
  }

  const validated = allResults
    .map(r => processRelease(r, media))
    .filter(r => r !== null);

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
  const allTitles = [media.title, ...(media.aliases || [])].map(t => t.replace(/[:]/g, '').trim());
  const normalizedTitles = allTitles.map(t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const combinedTitles = [...new Set([...allTitles, ...normalizedTitles])].filter(Boolean);

  const primary = combinedTitles[0] || media.title.replace(/[:]/g, '').trim();
  const baseTitle = stripSeasonInfo(primary);
  const others = combinedTitles.slice(1);
  const mediaSeason = getMediaSeason(media);
  const seasonPad = String(mediaSeason).padStart(2, '0');
  const seasonQueries = mediaSeason > 1
    ? [`${baseTitle} S${seasonPad}`, `${baseTitle} Season ${mediaSeason}`]
    : [];

  const plainBase = baseTitle.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const extraQueries = [];
  if (plainBase !== baseTitle) {
    extraQueries.push(plainBase);
    extraQueries.push(`${plainBase} Batch`);
  }

  const queryTiers = [
    [primary],
    others.length ? others : [],
    seasonQueries.length ? seasonQueries : [],
    [`${baseTitle} Batch`],
    extraQueries.length ? extraQueries : []
  ].filter(tier => tier.length > 0);

  // Only Nyaa as primary source
  const sourceList = ['nyaa_rss'];
  const searchFnMap = {
    nyaa_rss: searchNyaaRSS
  };
  return searchWithAggregation(media, sourceList, queryTiers, searchFnMap);
}

async function searchReleases(media) {
  const { categoryConfig } = require('../config');
  const category = categoryConfig[media.category];
  if (!category) return [];
  // Both anime and tokusatsu use the same Nyaa-based search
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
  const primaryResults = await searchReleases(media);
  const MIN_SEEDERS = 5;

  const hasGoodRelease = primaryResults.some(r => (r.seeders || 0) >= MIN_SEEDERS);
  if (primaryResults.length > 0 && hasGoodRelease) {
    return primaryResults;
  }

  let fallbackResults = [];
  const categoryId = media.category;
  try {
    const title = media.title || (media.aliases && media.aliases[0]) || '';
    if (title) {
      if (categoryId === 'anime') {
        const raw = await searchAnimeGarden(title);
        fallbackResults = raw
          .map(r => processRelease(r, media))
          .filter(r => r !== null);
      } else if (categoryId === 'tokusatsu') {
        const raw = await searchTorrentClaw(title);
        fallbackResults = raw
          .map(r => processRelease(r, media))
          .filter(r => r !== null);
      }
    }
  } catch (err) {
    console.warn('Fallback search failed:', err.message);
  }

  return mergeReleases(primaryResults, fallbackResults);
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
