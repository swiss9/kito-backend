function determineMediaScope(media) {
  if (!media) return 'unknown';
  if (media.mediaType === 'movie') return 'movie';
  if (media.seasonNumber != null) return 'season';
  return 'series';
}

function calculateCoverage(parsed, media) {
  const scope = determineMediaScope(media);

  const hasCompleteKeyword = parsed.originalName &&
    /complete\s*(series|season|batch|collection)|\bbatch\b|season\s*pack/i.test(parsed.originalName);

  if (scope === 'movie') {
    return { coverageType: 'movie', coveragePercent: 100 };
  }

  const episodeInfo = parsed.episodeInfo;
  if (!episodeInfo) {
    if (hasCompleteKeyword) {
      return {
        coverageType: scope === 'season' ? 'complete_season' : 'complete_series',
        coveragePercent: 100,
        episodeStart: null,
        episodeEnd: null
      };
    }
    return { coverageType: 'unknown', coveragePercent: null };
  }

  let totalEpisodes;
  if (scope === 'season') {
    totalEpisodes = media.seasonEpisodeCount;
  } else {
    totalEpisodes = media.totalEpisodeCount;
  }

  if (!totalEpisodes || totalEpisodes <= 0) {
    if (episodeInfo.type === 'range') {
      if (hasCompleteKeyword) {
        return {
          coverageType: scope === 'season' ? 'complete_season' : 'complete_series',
          coveragePercent: 100,
          episodeStart: episodeInfo.start,
          episodeEnd: episodeInfo.end
        };
      }
      return {
        coverageType: 'episode_range',
        coveragePercent: null,
        episodeStart: episodeInfo.start,
        episodeEnd: episodeInfo.end
      };
    }
    return {
      coverageType: 'single',
      coveragePercent: null,
      episodeStart: episodeInfo.start,
      episodeEnd: episodeInfo.end
    };
  }

  const covered = episodeInfo.end - episodeInfo.start + 1;
  const percent = Math.min(100, Math.round((covered / totalEpisodes) * 100));

  if (episodeInfo.type === 'range') {
    if (percent >= 90) {
      return {
        coverageType: scope === 'season' ? 'complete_season' : 'complete_series',
        coveragePercent: 100,
        episodeStart: episodeInfo.start,
        episodeEnd: episodeInfo.end
      };
    }
    return {
      coverageType: 'partial_batch',
      coveragePercent: percent,
      episodeStart: episodeInfo.start,
      episodeEnd: episodeInfo.end
    };
  }

  return {
    coverageType: 'single',
    coveragePercent: Math.round((1 / totalEpisodes) * 100),
    episodeStart: episodeInfo.start,
    episodeEnd: episodeInfo.end
  };
}

function buildCoverageGroups(candidates) {
  const groups = new Map();
  for (const cand of candidates) {
    const season = cand.season || 0;
    const key = `${season}|${cand.episodeStart}-${cand.episodeEnd}-${cand.coverageType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cand);
  }
  return groups;
}

module.exports = { determineMediaScope, calculateCoverage, buildCoverageGroups };
