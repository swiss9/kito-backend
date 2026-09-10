const { extractMagnetHash, normalizeTitle } = require('../utils');
const { parseReleaseName } = require('./releaseParser');
const { calculateCoverage, buildCoverageGroups } = require('./coverageEngine');
const { tokenSimilarity } = require('./titleService');
const { TRUSTED_GROUPS } = require('../config');

function computeWorkMatchConfidence(media, releaseTitle) {
  const mediaTitles = [media.title, ...(media.aliases || [])].map(t => normalizeTitle(t));
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

function computeFileSizeScore(sizeStr, quality, source, codec, episodeCount) {
  const sizeMB = parseSizeToMB(sizeStr);
  if (!sizeMB) return 0.5;
  const perEpisode = estimateReasonableSizeMB(quality, source, codec);
  const reasonable = perEpisode * (episodeCount || 1);
  const ratio = sizeMB / reasonable;
  if (ratio >= 0.8 && ratio <= 1.5) return 1.0;
  if (ratio < 0.8) return ratio / 0.8;
  if (ratio > 1.5 && ratio <= 3.0) return Math.max(0.2, 1 - (ratio - 1.5) * 0.4);
  if (ratio > 3.0) return 0.1;
  return 0.5;
}

function computeAvailabilityScore(seeders) {
  if (!seeders || seeders <= 0) return 0;
  return Math.min(1, Math.log10(seeders + 1) / 3);
}

function calculateReleaseScore(parsed, coverage, workMatch, seasonMatch, formatMatch, episodeIntentMatch, sizeScore, availabilityScore, rawRelease) {
  let score = 0;
  score += workMatch * 30;
  score += seasonMatch * 20;
  score += formatMatch * 10;
  score += episodeIntentMatch * 10;

  const covType = coverage.coverageType;
  if (covType === 'complete_series') score += 25;
  else if (covType === 'complete_season') score += 20;
  else if (covType === 'partial_batch') score += 10;
  else if (covType === 'single') score += 5;
  else if (covType === 'movie') score += 15;
  else if (covType === 'episode_range') score += 8;

  score += sizeScore * 5;
  score += availabilityScore * 5;

  if (parsed.quality >= 1080) score += 5;
  else if (parsed.quality >= 720) score += 3;

  if (parsed.source === 'bluray') score += 3;
  else if (parsed.source === 'web-dl') score += 2;

  const isTrusted = rawRelease.releaseGroup && TRUSTED_GROUPS.some(g => rawRelease.releaseGroup.toLowerCase().includes(g.toLowerCase()));
  if (isTrusted) score += 5;

  return Math.min(score, 100);
}

function rankReleases(media, releases, queryIntent) {
  const candidates = releases.map(r => {
    const parsed = parseReleaseName(r.name);
    const coverage = calculateCoverage(parsed, media);
    const workMatch = computeWorkMatchConfidence(media, parsed.title || r.name);
    const seasonMatch = computeSeasonMatchConfidence(media, parsed);
    const formatMatch = computeFormatConfidence(media, parsed, queryIntent);
    const episodeIntentMatch = computeEpisodeIntentMatch(queryIntent, parsed);
    const episodeCount = (parsed.episodeInfo && parsed.episodeInfo.type === 'range') ? (parsed.episodeInfo.end - parsed.episodeInfo.start + 1) : 1;
    const sizeScore = computeFileSizeScore(r.size, parsed.quality, parsed.source, parsed.codec, episodeCount);
    const availabilityScore = computeAvailabilityScore(r.seeders);
    const score = calculateReleaseScore(parsed, coverage, workMatch, seasonMatch, formatMatch, episodeIntentMatch, sizeScore, availabilityScore, r);
    return {
      ...r,
      ...parsed,
      coverageType: coverage.coverageType,
      coveragePercent: coverage.coveragePercent,
      episodeStart: coverage.episodeStart,
      episodeEnd: coverage.episodeEnd,
      workMatchConfidence: workMatch,
      seasonMatchConfidence: seasonMatch,
      formatConfidence: formatMatch,
      episodeIntentMatch,
      score,
      sizeScore,
      availabilityScore
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
      result.push(group[0]);
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

  return result;
}

function isReleaseValid(release, media) {
  return true;
}

module.exports = { rankReleases, deduplicateReleases, selectBestCandidates, isReleaseValid };
