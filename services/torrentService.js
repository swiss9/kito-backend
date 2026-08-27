const xml2js = require('xml2js');
const { TORRENTCLAW_API_KEY } = require('../config');
const { setCache, getCached, normalizeTitle, extractMagnetHash, stripSeasonInfo } = require('../utils');
const { processRelease, getMediaSeason } = require('./rankingService');
const { httpGet } = require('./httpClient');

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
  const cached = await getCached(cacheKey);
  if (cached) return cached;

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

  const franchiseRoot = extractFranchiseTitle(primary);
  const queryTiers = [];

  if (franchiseRoot && franchiseRoot !== primary && franchiseRoot.length > 1) {
    queryTiers.push([franchiseRoot]);
    queryTiers.push([`${franchiseRoot} Batch`]);
  }

  queryTiers.push([primary]);
  if (others.length) queryTiers.push(others);
  if (seasonQueries.length) queryTiers.push(seasonQueries);
  queryTiers.push([`${baseTitle} Batch`]);
  if (extraQueries.length) queryTiers.push(extraQueries);

  if (media.category === 'tokusatsu') {
    const batchVariants = [
      `${baseTitle} Complete`,
      `${baseTitle} Complete Series`,
      `${baseTitle} Complete Batch`,
      `${primary} Complete`,
      `${primary} Complete Series`,
      `${primary} Complete Batch`
    ];
    queryTiers.push(batchVariants);
  }

  if (media.mediaType === 'movie' || media.format === 'SPECIAL') {
    const franchiseTitle = extractFranchiseTitle(primary);
    if (franchiseTitle && franchiseTitle !== primary && franchiseTitle.length > 2) {
      queryTiers.push([franchiseTitle]);
      queryTiers.push([`${franchiseTitle} Movie`]);
      queryTiers.push([`${franchiseTitle} OVA`]);
      queryTiers.push([`${franchiseTitle} Film`]);
      queryTiers.push([`${primary} Movie`]);
      if (media.year) queryTiers.push([`${franchiseTitle} ${media.year}`]);
      if (media.format === 'SPECIAL') {
        queryTiers.push([`${franchiseTitle} SD`]);
        queryTiers.push([`${franchiseTitle} Special`]);
      }
      if (primary !== franchiseTitle) {
        queryTiers.push([primary]);
      }
    }
  }

  console.log(`[search] Query tiers for "${media.title}": ${queryTiers.length} tiers, total queries: ${queryTiers.flat().length}`);

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
        const raw = await searchTorrentClaw(media.title);
        fallbackResults = raw.map(r => processRelease(r, media)).filter(r => r !== null);
        if (fallbackResults.length === 0) {
          const gardenRaw = await searchAnimeGarden(media.title);
          fallbackResults = gardenRaw.map(r => processRelease(r, media)).filter(r => r !== null);
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
