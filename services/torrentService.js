const xml2js = require('xml2js');
const { TORRENTCLAW_API_KEY } = require('../config');
const { setCache, getCached, normalizeTitle, extractMagnetHash, stripSeasonInfo } = require('../utils');
const { processRelease, getMediaSeason } = require('./rankingService');

async function searchTorrentClaw(title) {
  const baseUrl = 'https://torrentclaw.com/api/search';
  const params = new URLSearchParams({ q: title, category: 'all', limit: 100 });
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

const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

async function searchNyaaRSS(title) {
  const url = `https://nyaa.si/?page=rss&c=1_2&q=${encodeURIComponent(title)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Nyaa RSS: ${res.status}`);
  const text = await res.text();
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
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
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
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
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

// Simple concurrency limiter
async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function searchWithAggregation(media, sourceList, queryTiers, searchFnMap) {
  const allResults = [];

  for (const src of sourceList) {
    const searchFn = searchFnMap[src];
    if (!searchFn) continue;

    // Flatten tiers and deduplicate queries for this source
    const queries = [...new Set(queryTiers.flat().filter(Boolean))];

    const srcResults = await mapWithConcurrency(queries, 4, async (q) => {
      try {
        return await searchFn(q);
      } catch (err) {
        console.warn(`Source ${src} query "${q}" failed:`, err.message);
        return [];
      }
    });

    allResults.push(...srcResults.flat());
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

  const sourceList = ['nyaa_rss', 'torrentclaw'];
  const searchFnMap = {
    nyaa_rss: searchNyaaRSS,
    torrentclaw: searchTorrentClaw
  };
  return searchWithAggregation(media, sourceList, queryTiers, searchFnMap);
}

async function searchMovieReleases(media) {
  const allTitles = [media.title, ...(media.aliases || [])].map(t => t.replace(/[:]/g, '').trim());
  const normalizedTitles = allTitles.map(t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const combinedTitles = [...new Set([...allTitles, ...normalizedTitles])].filter(Boolean);
  const primary = combinedTitles[0] || media.title.replace(/[:]/g, '').trim();
  const others = combinedTitles.slice(1);
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
  const normalizedTitles = allTitles.map(t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const combinedTitles = [...new Set([...allTitles, ...normalizedTitles])].filter(Boolean);
  const primary = combinedTitles[0] || media.title.replace(/[:]/g, '').trim();
  const baseTitle = stripSeasonInfo(primary);
  const others = combinedTitles.slice(1);

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
  const { categoryConfig } = require('../config');
  const category = categoryConfig[media.category];
  if (!category) return [];
  if (category.id === 'anime' || category.id === 'tokusatsu') {
    return searchAnimeReleases(media);
  } else if (category.id === 'hollywood' || category.id === 'bollywood' || category.id === 'animation') {
    return searchMovieReleases(media);
  } else if (category.id === 'asian') {
    return searchSeriesReleases(media);
  }
  return [];
}

module.exports = {
  searchTorrentClaw,
  searchNyaaRSS,
  searchYTS,
  searchEZTV,
  searchWithAggregation,
  searchAnimeReleases,
  searchMovieReleases,
  searchSeriesReleases,
  searchReleases
};
