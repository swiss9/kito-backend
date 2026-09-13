const { extractMagnetHash, normalizeTitle } = require('../utils');
const { parseReleaseName } = require('./releaseParser');
const { calculateCoverage, buildCoverageGroups } = require('./coverageEngine');
const { tokenSimilarity } = require('./titleService');
const { TRUSTED_GROUPS, SEQUEL_KEYWORDS } = require('../config');

const EXCLUDED_SEQUEL_KEYWORDS = new Set(['movie', 'film', 'ova', 'special']);

const SEQUEL_PHRASES = [...new Set(
  SEQUEL_KEYWORDS
    .filter(k => !EXCLUDED_SEQUEL_KEYWORDS.has(k))
    .map(k => normalizeTitle(k))
    .filter(Boolean)
)];

const EXTRA_TOKEN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'no', 'na', 'wa', 'wo', 'ga',
  'series', 'complete', 'batch', 'collection', 'season', 'part', 'cour',
  'movie', 'movies', 'film', 'films', 'ova', 'ovas', 'special', 'specials',
  'episode', 'episodes', 'vol', 'volume', 'volumes',
  'dub', 'dubs', 'sub', 'subs', 'dual', 'multi'
]);

const COVERAGE_MULTIPLIER = {
  complete_series: 1.30,
  complete_season: 1.25,
  movie: 1.15,
  partial_batch: 1.10,
  single: 1.00,
  episode_range: 0.90,
  unknown: 0.55
};

function containsTokenSequence(haystack, needle) {
  if (!haystack || !needle) return false;
  const h = haystack.split(' ').filter(Boolean);
  const n = needle.split(' ').filter(Boolean);
  if (n.length === 0 || n.length > h.length) return false;
  for (let i = 0; i <= h.length - n.length; i++) {
    let matched = true;
    for (let j = 0; j < n.length; j++) {
      if (h[i + j] !== n[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function seedersMultiplier(seeders) {
  if (seeders >= 100) return 1.20;
  if (seeders >= 50) return 1.10;
  if (seeders >= 20) return 1.00;
  if (seeders >= 5) return 0.85;
  if (seeders >= 1) return 0.60;
  return 0.15;
}

function isTrustedGroup(releaseGroup) {
  if (!releaseGroup) return false;
  const lower = releaseGroup.toLowerCase();
  for (const g of TRUSTED_GROUPS) {
    const gl = g.toLowerCase();
    const idx = lower.indexOf(gl);
    if (idx === -1) continue;
    const before = idx === 0 ? ' ' : lower[idx - 1];
    const after = idx + gl.length >= lower.length ? ' ' : lower[idx + gl.length];
    if (/[\s\-_[\]]/.test(before) && /[\s\-_[\]]/.test(after)) return true;
  }
  return false;
}

function computeWorkMatchConfidence(media, releaseTitle) {
  const mediaTitles = [media.title, ...(media.aliases || [])].map(t => normalizeTitle(t)).filter(Boolean);
  let best = 0;
  for (const mt of mediaTitles) {
    const sim = tokenSimilarity(mt, releaseTitle);
    if (sim > best) best = sim;
  }
  if (best === 1) return 1.0;
  if (best >= 0.9) return 0.95;
  if (best >= 0.8) return 0.85;
  if (best >= 0.6) return 0.6;
  if (best >= 0.4) return 0.4;
  return 0.2;
}

function computeSequelPenalty(media, releaseTitle) {
  if (!releaseTitle) return 0;
  const releaseNorm = normalizeTitle(releaseTitle);
  if (!releaseNorm) return 0;

  const mediaTitlesNorm = [media.title, ...(media.aliases || [])]
    .map(t => normalizeTitle(t))
    .filter(Boolean);

  for (const marker of SEQUEL_PHRASES) {
    if (!releaseNorm.includes(marker)) continue;
    const inMedia = mediaTitlesNorm.some(t => t.includes(marker));
    if (inMedia) continue;
    return 0.5;
  }
  return 0;
}

function computeExtraTokenPenalty(media, releaseTitle) {
  if (!releaseTitle) return 0;
  const releaseNorm = normalizeTitle(releaseTitle);
  if (!releaseNorm) return 0;

  const releaseTokens = releaseNorm.split(/\s+/).filter(Boolean);
  if (releaseTokens.length === 0) return 0;

  const mediaTokens = new Set();
  for (const t of [media.title, ...(media.aliases || [])]) {
    const norm = normalizeTitle(t);
    if (!norm) continue;
    for (const tok of norm.split(/\s+/)) {
      if (tok) mediaTokens.add(tok);
    }
  }

  let penalty = 0;
  const extras = releaseTokens.filter(t =>
    t.length > 2 && !EXTRA_TOKEN_STOPWORDS.has(t) && !mediaTokens.has(t)
  );

  if (extras.length >= 4) penalty = 0.6;
  else if (extras.length >= 3) penalty = 0.4;
  else if (extras.length >= 2) penalty = 0.2;

  const releaseYearMatch = releaseNorm.match(/\b(19|20)\d{2}\b/);
  if (releaseYearMatch && media.year) {
    const releaseYear = parseInt(releaseYearMatch[0]);
    const diff = Math.abs(releaseYear - media.year);
    if (diff >= 2) {
      penalty = Math.max(penalty, 0.4);
    } else if (diff === 1) {
      penalty = Math.max(penalty, 0.2);
    }
  }

  return penalty;
}

function computeSeasonMatchConfidence(media, parsed) {
  if (!media.seasonNumber) {
    if (parsed.season) return 0.6;
    return 0.8;
  }
  if (parsed.season == null) return 0.4;
  if (parsed.season === media.seasonNumber) return 1.0;
  return 0.1;
}

function computeFormatConfidence(media, parsed, queryIntent) {
  if (media.mediaType === 'movie') {
    return parsed.episodeInfo ? 0.4 : 0.9;
  }
  if (queryIntent && queryIntent.requestedFormat === 'movie') return 0.1;
  return 0.8;
}

function computeEpisodeIntentMatch(queryIntent, parsed) {
  if (!queryIntent) return 0.5;
  if (!parsed.episodeInfo) return 0.2;
  if (queryIntent.episodeRange) {
    if (parsed.episodeInfo.type === 'range') {
      const intentRange = queryIntent.episodeRange;
      const releaseRange = { start: parsed.episodeInfo.start, end: parsed.episodeInfo.end };
      const overlap = Math.max(0, Math.min(intentRange.end, releaseRange.end) - Math.max(intentRange.start, releaseRange.start) + 1);
      const totalNeeded = intentRange.end - intentRange.start + 1;
      const overlapRatio = overlap / totalNeeded;
      return overlapRatio >= 0.9 ? 1.0 : overlapRatio >= 0.5 ? 0.7 : 0.3;
    }
    return 0.1;
  }
  if (queryIntent.episodeNumber) {
    if (parsed.episodeInfo.type === 'single' && parsed.episodeInfo.start === queryIntent.episodeNumber) {
      return 1.0;
    }
    if (parsed.episodeInfo.type === 'range') {
      if (queryIntent.episodeNumber >= parsed.episodeInfo.start && queryIntent.episodeNumber <= parsed.episodeInfo.end) {
        return 0.7;
      }
    }
    return 0.1;
  }
  return 0.5;
}

function estimateReasonableSizeMB(quality, source, codec) {
  let base = 500;
  if (quality >= 2160) base = 4000;
  else if (quality >= 1080) base = 1200;
  else if (quality >= 720) base = 700;
  else if (quality >= 480) base = 300;
  else base = 200;

  if (source === 'bluray') base *= 1.2;
  else if (source === 'web-dl') base *= 0.9;

  if (codec === 'x265' || codec === 'hevc') base *= 0.7;

  return base;
}

function parseSizeToMB(sizeStr) {
  if (!sizeStr) return null;
  const match = sizeStr.match(/([\d.]+)\s*(GB|GiB|MB|MiB|KB|KiB)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('g')) return value * 1024;
  if (unit.startsWith('m')) return value;
  if (unit.startsWith('k')) return value / 1024;
  return null;
}

function computeFileSizeMultiplier(sizeStr, quality, source, codec, episodeCount) {
  const sizeMB = parseSizeToMB(sizeStr);
  if (!sizeMB) return 1.0;
  const perEpisode = estimateReasonableSizeMB(quality, source, codec);
  const reasonable = perEpisode * (episodeCount || 1);
  const ratio = sizeMB / reasonable;
  if (ratio >= 0.8 && ratio <= 1.5) return 1.0;
  if (ratio < 0.8) return 0.7 + (ratio / 0.8) * 0.3;
  if (ratio > 1.5 && ratio <= 3.0) return Math.max(0.5, 1 - (ratio - 1.5) * 0.25);
  if (ratio > 3.0) return 0.4;
  return 0.7;
}

function computeEpisodeCountForSize(parsed, coverage, media) {
  if (coverage.coverageType === 'complete_series') {
    return media.totalEpisodeCount || media.episodeCount || 1;
  }
  if (coverage.coverageType === 'complete_season') {
    return media.seasonEpisodeCount || media.episodeCount || 1;
  }
  if (coverage.coverageType === 'movie') {
    return 1;
  }
  if (parsed.episodeInfo && parsed.episodeInfo.type === 'range') {
    return parsed.episodeInfo.end - parsed.episodeInfo.start + 1;
  }
  return 1;
}

function computeConfidenceLabel(workMatch, coverage, media) {
  const covType = coverage.coverageType;

  if (covType === 'unknown') return 'low';
  if (covType === 'movie' && media.mediaType !== 'movie') return 'low';

  if (covType === 'complete_series' || covType === 'complete_season' || covType === 'movie') {
    if (workMatch >= 0.8) return 'high';
    if (workMatch >= 0.5) return 'medium';
    return 'low';
  }

  if (workMatch >= 0.9) return 'high';
  if (workMatch >= 0.6) return 'medium';
  return 'low';
}

function computePopularityBonus(media) {
  if (!media || !media.popularity) return 0;
  const p = media.popularity;
  if (p >= 8.0) return 4;
  if (p >= 7.0) return 2;
  if (p >= 5.5) return 1;
  return 0;
}

function calculateReleaseScore(parsed, coverage, workMatch, seasonMatch, formatMatch, episodeIntentMatch, sizeMultiplier, media) {
  if (Array.isArray(media.forbiddenTitles) && media.forbiddenTitles.length > 0) {
    const releaseNorm = normalizeTitle(parsed.title || parsed.originalName);
    for (const forbidden of media.forbiddenTitles) {
      const fn = normalizeTitle(forbidden);
      if (fn.length >= 3 && containsTokenSequence(releaseNorm, fn)) {
        return 0;
      }
    }
  }

  let base = 0;
  base += workMatch * 40;
  base += seasonMatch * 15;
  base += formatMatch * 10;
  base += episodeIntentMatch * 10;
  base += computePopularityBonus(media);

  const covType = coverage.coverageType;
  const coverageMult = COVERAGE_MULTIPLIER[covType] || 0.55;
  base *= coverageMult;

  const seedMult = seedersMultiplier(parsed.seeders);
  base *= seedMult;

  if (parsed.isMovieRelease && media.mediaType !== 'movie') {
    base *= 0.4;
  }

  base *= sizeMultiplier;

  if (parsed.quality >= 2160) base += 5;
  else if (parsed.quality >= 1080) base += 3;
  else if (parsed.quality >= 720) base += 1;
  else if (parsed.quality >= 480) base -= 3;
  else if (parsed.quality > 0) base -= 5;

  if (parsed.source === 'bluray') base += 4;
  else if (parsed.source === 'web-dl') base += 2;
  else if (parsed.source === 'hdtv') base -= 2;

  if (isTrustedGroup(parsed.group)) base += 8;

  const sequelPenalty = computeSequelPenalty(media, parsed.title || parsed.originalName);
  if (sequelPenalty > 0) base *= (1 - sequelPenalty);

  const extraTokenPenalty = computeExtraTokenPenalty(media, parsed.title || parsed.originalName);
  if (extraTokenPenalty > 0) base *= (1 - extraTokenPenalty);

  return Math.max(0, Math.min(base, 100));
}

function rankReleases(media, releases, queryIntent) {
  const candidates = releases.map(r => {
    const parsed = parseReleaseName(r.name);
    parsed.seeders = r.seeders || 0;
    parsed.leechers = r.leechers || 0;

    const coverage = calculateCoverage(parsed, media);
    const workMatch = computeWorkMatchConfidence(media, parsed.title || r.name);
    const seasonMatch = computeSeasonMatchConfidence(media, parsed);
    const formatMatch = computeFormatConfidence(media, parsed, queryIntent);
    const episodeIntentMatch = computeEpisodeIntentMatch(queryIntent, parsed);
    const episodeCount = computeEpisodeCountForSize(parsed, coverage, media);
    const sizeMultiplier = computeFileSizeMultiplier(r.size, parsed.quality, parsed.source, parsed.codec, episodeCount);
    const score = calculateReleaseScore(parsed, coverage, workMatch, seasonMatch, formatMatch, episodeIntentMatch, sizeMultiplier, media);
    const confidenceLabel = computeConfidenceLabel(workMatch, coverage, media);

    return {
      ...r,
      ...parsed,
      releaseGroup: parsed.group,
      confidence: confidenceLabel,
      coverageType: coverage.coverageType,
      coveragePercent: coverage.coveragePercent,
      episodeStart: coverage.episodeStart,
      episodeEnd: coverage.episodeEnd,
      workMatchConfidence: workMatch,
      seasonMatchConfidence: seasonMatch,
      formatConfidence: formatMatch,
      episodeIntentMatch,
      score,
      sizeMultiplier
    };
  });

  const deduped = deduplicateReleases(candidates);
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

function deduplicateReleases(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const magnetHash = extractMagnetHash(c.magnet);
    let key = magnetHash;
    if (!key) {
      key = `${normalizeTitle(c.name)}|${c.season || ''}|${c.episodeStart}-${c.episodeEnd}|${c.coverageType}|${c.quality}|${c.source}|${c.codec}`;
    }
    if (!map.has(key) || c.score > map.get(key).score) {
      map.set(key, c);
    }
  }
  return Array.from(map.values());
}

function selectBestCandidates(ranked, media, queryIntent) {
  const result = [];
  const seasonGroups = new Map();

  for (const c of ranked) {
    const season = c.season || 0;
    const coverageType = c.coverageType;
    const key = `${season}|${coverageType}`;
    if (!seasonGroups.has(key)) seasonGroups.set(key, []);
    seasonGroups.get(key).push(c);
  }

  for (const [key, group] of seasonGroups.entries()) {
    const coverageType = key.split('|')[1];
    if (coverageType === 'complete_series' || coverageType === 'complete_season' || coverageType === 'movie') {
      group.sort((a, b) => b.score - a.score);
      result.push(...group.slice(0, 3));
    }
  }

  if (result.length === 0) {
    const episodeGroups = new Map();
    for (const c of ranked) {
      if (c.coverageType === 'single' || c.coverageType === 'partial_batch') {
        const season = c.season || 0;
        const epKey = `${season}|${c.episodeStart}`;
        if (!episodeGroups.has(epKey)) episodeGroups.set(epKey, []);
        episodeGroups.get(epKey).push(c);
      }
    }

    const sortedKeys = Array.from(episodeGroups.keys()).sort((a, b) => {
      const [sa, ea] = a.split('|').map(Number);
      const [sb, eb] = b.split('|').map(Number);
      if (sa !== sb) return sa - sb;
      return ea - eb;
    });

    for (const epKey of sortedKeys) {
      const group = episodeGroups.get(epKey);
      group.sort((a, b) => b.score - a.score);
      result.push(group[0]);
    }
  }

  if (result.length === 0 && ranked.length > 0) {
    result.push(ranked[0]);
  }

  const seenMagnet = new Set();
  return result.filter(r => {
    const key = r.magnet || r.name;
    if (seenMagnet.has(key)) return false;
    seenMagnet.add(key);
    return true;
  });
}

function isReleaseValid(release, media) {
  if (!release) return false;
  if (typeof release.name !== 'string' || release.name.length === 0) return false;
  if (typeof release.magnet !== 'string' || release.magnet.length === 0) return false;
  return true;
}

module.exports = { rankReleases, deduplicateReleases, selectBestCandidates, isReleaseValid };
