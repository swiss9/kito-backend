const { extractMagnetHash, normalizeTitle } = require('../utils');
const { parseReleaseName } = require('./releaseParser');
const { tokenSimilarity, normalizeTitle } = require('./titleService');

function determineMediaScope(media) {
  if (!media) return 'unknown';
  if (media.mediaType === 'movie') return 'movie';
  if (media.seasonNumber != null) return 'season';
  return 'series';
}

function calculateCoverage(parsed, media) {
  const scope = determineMediaScope(media);
  if (scope === 'movie') {
    return { coverageType: 'movie', coveragePercent: 100 };
  }

  const episodeInfo = parsed.episodeInfo;
  if (!episodeInfo) {
    return { coverageType: 'unknown', coveragePercent: null };
  }

  let totalEpisodes;
  if (scope === 'season') {
    totalEpisodes = media.seasonEpisodeCount;
  } else {
    totalEpisodes = media.totalEpisodeCount || media.episodeCount;
  }

  if (!totalEpisodes || totalEpisodes <= 0) {
    if (episodeInfo.type === 'range') {
      return { coverageType: 'episode_range', coveragePercent: null, episodeStart: episodeInfo.start, episodeEnd: episodeInfo.end };
    } else {
      return { coverageType: 'single', coveragePercent: null, episodeStart: episodeInfo.start, episodeEnd: episodeInfo.end };
    }
  }

  const covered = episodeInfo.end - episodeInfo.start + 1;
  const percent = Math.min(100, Math.round((covered / totalEpisodes) * 100));

  if (episodeInfo.type === 'range') {
    if (percent >= 90) {
      if (scope === 'season') {
        return { coverageType: 'complete_season', coveragePercent: 100, episodeStart: episodeInfo.start, episodeEnd: episodeInfo.end };
      } else {
        return { coverageType: 'complete_series', coveragePercent: 100, episodeStart: episodeInfo.start, episodeEnd: episodeInfo.end };
      }
    } else {
      return { coverageType: 'partial_batch', coveragePercent: percent, episodeStart: episodeInfo.start, episodeEnd: episodeInfo.end };
    }
  } else {
    return { coverageType: 'single', coveragePercent: Math.round((1 / totalEpisodes) * 100), episodeStart: episodeInfo.start, episodeEnd: episodeInfo.end };
  }
}

function computeSeasonMatchConfidence(media, parsed) {
  if (!media.seasonNumber) {
    if (parsed.season) return 0.6;
    return 0.5;
  }
  if (parsed.season == null) return 0.4;
  if (parsed.season === media.seasonNumber) return 1.0;
  return 0.1;
}

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

function computeFormatConfidence(media, parsed, queryIntent) {
  if (media.mediaType === 'movie' && queryIntent && queryIntent.requestedFormat === 'movie') return 1.0;
  if (media.mediaType === 'movie') return 0.9;
  if (queryIntent && queryIntent.requestedFormat === 'movie') return 0.1;
  if (queryIntent && queryIntent.requestedFormat) return 0.8;
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

function calculateReleaseScore(parsed, coverage, workMatch, seasonMatch, formatMatch, episodeIntentMatch, rawRelease) {
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

  if (parsed.quality >= 1080) score += 10;
  else if (parsed.quality >= 720) score += 5;

  if (parsed.source === 'bluray') score += 5;
  else if (parsed.source === 'web-dl') score += 3;

  if (rawRelease.seeders > 100) score += 5;
  else if (rawRelease.seeders > 50) score += 2;

  return Math.min(score, 100);
}

function rankReleases(media, releases, queryIntent) {
  const ranked = releases.map(r => {
    const parsed = parseReleaseName(r.name);
    const coverage = calculateCoverage(parsed, media);
    const workMatch = computeWorkMatchConfidence(media, parsed.title || r.name);
    const seasonMatch = computeSeasonMatchConfidence(media, parsed);
    const formatMatch = computeFormatConfidence(media, parsed, queryIntent);
    const episodeIntentMatch = computeEpisodeIntentMatch(queryIntent, parsed);
    const score = calculateReleaseScore(parsed, coverage, workMatch, seasonMatch, formatMatch, episodeIntentMatch, r);
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
      score
    };
  });
  const deduped = deduplicateReleases(ranked);
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

function deduplicateReleases(releases) {
  const map = new Map();
  for (const r of releases) {
    const magnetHash = extractMagnetHash(r.magnet);
    let key = magnetHash;
    if (!key) {
      key = `${normalizeTitle(r.name)}|${r.season || ''}|${r.episodeInfo ? r.episodeInfo.type + r.episodeInfo.start + '-' + r.episodeInfo.end : ''}|${r.quality}|${r.source}|${r.codec}`;
    }
    if (!map.has(key) || r.score > map.get(key).score) {
      map.set(key, r);
    }
  }
  return Array.from(map.values());
}

module.exports = { rankReleases, deduplicateReleases, calculateCoverage, calculateReleaseScore };
