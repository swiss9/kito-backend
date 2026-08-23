const { normalizeTitle, extractReleaseTitle, escapeRegex, wordBoundaryMatch, getReleaseGroup } = require('../utils');
const { CoverageType, MediaType, SEQUEL_KEYWORDS, TRUSTED_GROUPS } = require('../config');

function parseReleaseName(name) {
  const episode = extractEpisodeNumber(name);
  const season = extractSeasonNumber(name);
  const releaseGroup = getReleaseGroup(name);
  const qualityInfo = parseQuality(name);
  const source = parseSource(name);
  const title = extractReleaseTitle(name);
  return { episodeNumber: episode, season, releaseGroup, quality: qualityInfo.quality, qualityLabel: qualityInfo.label, source, title };
}

function extractEpisodeNumber(name) {
  if (!name) return null;
  let clean = name
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|360p|4k|8k)\b/gi, ' ')
    .replace(/\b(19\d\d|20\d\d)\b/g, ' ');
  const patterns = [
    /[Ss](\d+)[Ee](\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)/i,
    /[Ee](\d{2,3})(?![0-9])/,
    /(?:^|\s)-?\s*(\d{1,3})\s*(?:$|\s)/,
    /\[(\d+)\]/,
    /\((\d+)\)/
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      const num = parseInt(match[match.length - 1]);
      if (num > 0 && num < 1000) return num;
    }
  }
  return null;
}

function extractSeasonNumber(name) {
  if (!name) return null;
  const clean = name.replace(/\[.*?\]|\(.*?\)/g, ' ');
  const ordinalMatch = clean.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  if (ordinalMatch) return parseInt(ordinalMatch[1]);
  const romanMap = { 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6 };
  const romanMatch = clean.match(/\b(II|III|IV|V|VI)\b/);
  if (romanMatch) return romanMap[romanMatch[1]];
  const patterns = [
    /[Ss](\d+)[Ee]\d+/,
    /[Ss]eason\s*(\d+)/i,
    /S(\d+)\s*Complete/i,
    /\b(\d+)$/
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      const s = parseInt(match[1]);
      if (s > 0 && s < 100) return s;
    }
  }
  return null;
}

function extractEpisodeRange(name) {
  const clean = name.replace(/\[.*?\]|\(.*?\)/g, ' ');
  const patterns = [
    /(\d+)\s*[-–~]\s*(\d+)/,
    /[Ss](\d+)[Ee](\d+)\s*[-–~]\s*[Ee]?(\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)\s*[-–~]\s*(\d+)/i,
    /[Ee](\d+)\s*[-–~]\s*[Ee]?(\d+)/
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      let start, end;
      if (match.length === 3) {
        start = parseInt(match[1]);
        end = parseInt(match[2]);
      } else if (match.length === 4) {
        start = parseInt(match[2]);
        end = parseInt(match[3]);
      } else continue;
      if (start > 0 && end > 0 && start < end && end < 1000) return { start, end };
    }
  }
  return null;
}

function isBatchRelease(name) {
  if (extractEpisodeRange(name)) return true;
  const lower = name.toLowerCase();
  return /batch|season pack|all episodes|full season|complete series|box set|s\d+ complete|season \d+ complete/i.test(lower);
}

function parseQuality(name) {
  const match = name.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  if (match) {
    const q = match[1].toLowerCase();
    if (q === '2160p' || q === '4k') return { quality: 2160, label: '2160p' };
    if (q === '1080p') return { quality: 1080, label: '1080p' };
    if (q === '720p') return { quality: 720, label: '720p' };
    if (q === '480p') return { quality: 480, label: '480p' };
    if (q === '360p') return { quality: 360, label: '360p' };
  }
  return { quality: 0, label: 'Unknown' };
}

function parseSource(name) {
  const match = name.match(/\b(WEB-DL|WEBRip|BluRay|DVD|HDTV)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function getForbiddenTitles(media) {
  const forbidden = [];
  if (media.relations) {
    for (const rel of media.relations) {
      if (rel.title && ['SEQUEL', 'PREQUEL', 'SPIN_OFF', 'ALTERNATIVE', 'SIDE_STORY', 'SUMMARY'].includes(rel.relationType)) {
        forbidden.push(rel.title);
      }
    }
  }
  const mediaTitleLower = media.title.toLowerCase();
  for (const kw of SEQUEL_KEYWORDS) {
    if (!mediaTitleLower.includes(kw) && !forbidden.some(f => f.toLowerCase().includes(kw))) {
      forbidden.push(kw);
    }
  }
  return forbidden.map(t => normalizeTitle(t)).filter(t => t.length > 2);
}

function getMediaSeason(media) {
  const titles = [media.title, ...(media.aliases || [])];
  for (const t of titles) {
    const parsed = parseReleaseName(t);
    if (parsed.season !== null) return parsed.season;
    const norm = normalizeTitle(t);
    const match = norm.match(/\s([2-9])$/);
    if (match) return parseInt(match[1]);
  }
  return 1;
}

function validateRelease(parsed, media) {
  const releaseTitle = normalizeTitle(parsed.title || extractReleaseTitle(parsed.originalName));
  const mediaTitles = [media.title, ...media.aliases].map(normalizeTitle);
  const forbiddenTitles = getForbiddenTitles(media);

  let titleMatch = false;
  for (const mt of mediaTitles) {
    if (wordBoundaryMatch(releaseTitle, mt)) {
      titleMatch = true;
      break;
    }
  }
  if (!titleMatch) return { valid: false, reason: 'title_mismatch' };

  const mediaSeason = getMediaSeason(media);
  const releaseSeason = parsed.season ?? 1;

  if (releaseSeason !== mediaSeason) {
    const relTitleNorm = normalizeTitle(extractReleaseTitle(parsed.originalName));
    if (mediaSeason === 1) {
      const seasonIndicators = [`s0?2`, `season 2`, `2nd season`];
      if (seasonIndicators.some(ind => new RegExp(`\\b${ind}\\b`, 'i').test(relTitleNorm))) {
        return { valid: false, reason: 'season_mismatch' };
      }
    } else {
      const seasonRegex = new RegExp(`\\b(season\\s*0?${mediaSeason}|s0?${mediaSeason})\\b`, 'i');
      const romanMap = { 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v' };
      const romanString = romanMap[mediaSeason] ? `\\b${romanMap[mediaSeason]}\\b` : null;
      let matchesSeason = seasonRegex.test(relTitleNorm);
      if (!matchesSeason && romanString) {
        matchesSeason = new RegExp(romanString, 'i').test(relTitleNorm);
      }
      if (!matchesSeason) return { valid: false, reason: 'season_mismatch' };
    }
  }

  for (const forb of forbiddenTitles) {
    if (!forb) continue;
    const forbRegex = new RegExp(`\\b${escapeRegex(forb)}\\b`, 'i');
    if (forbRegex.test(releaseTitle)) {
      const mediaContainsForbidden = mediaTitles.some(mt => forbRegex.test(mt));
      if (!mediaContainsForbidden) {
        return { valid: false, reason: 'forbidden_relation' };
      }
    }
  }

  const range = extractEpisodeRange(parsed.originalName);
  let episodeStart = null, episodeEnd = null;
  if (range) {
    episodeStart = range.start;
    episodeEnd = range.end;
  } else {
    const ep = parsed.episodeNumber;
    episodeStart = ep;
    episodeEnd = ep;
  }

  if (media.episodeCount && media.episodeCount > 0) {
    if (episodeStart !== null && episodeStart > media.episodeCount) return { valid: false, reason: 'episode_out_of_range' };
    if (episodeEnd !== null && episodeEnd > media.episodeCount) return { valid: false, reason: 'episode_out_of_range' };
  }

  return { valid: true, episodeStart, episodeEnd };
}

function calculateConfidence(parsed, media) {
  const releaseTitle = normalizeTitle(parsed.title || extractReleaseTitle(parsed.originalName));
  const mediaTitles = [media.title, ...media.aliases].map(normalizeTitle);
  const exactTitleMatch = mediaTitles.some(mt => releaseTitle === mt);
  const isTrusted = TRUSTED_GROUPS.some(g => parsed.releaseGroup && parsed.releaseGroup.toLowerCase().includes(g.toLowerCase()));
  if (exactTitleMatch && isTrusted) return 'high';
  if (exactTitleMatch || isTrusted) return 'high';
  return 'medium';
}

function calculateScore(parsed, coverageType, coveragePercent, media) {
  let score = 0;
  if (coverageType === CoverageType.COMPLETE) score += 40;
  else if (coverageType === CoverageType.PARTIAL) score += 20;
  else if (coverageType === CoverageType.SINGLE) score += 10;

  const quality = parsed.quality || 0;
  if (quality >= 1080) score += 30;
  else if (quality >= 720) score += 20;
  else if (quality >= 480) score += 10;

  const source = parsed.source || '';
  if (source === 'bluray') score += 20;
  else if (source === 'web-dl') score += 10;

  if (parsed.seeders > 100) score += 10;
  else if (parsed.seeders > 50) score += 5;

  const isTrusted = TRUSTED_GROUPS.some(g => parsed.releaseGroup && parsed.releaseGroup.toLowerCase().includes(g.toLowerCase()));
  if (isTrusted) score += 15;

  return Math.min(score, 100);
}

function processRelease(rawRelease, media) {
  const parsed = parseReleaseName(rawRelease.name);
  parsed.originalName = rawRelease.name;
  parsed.seeders = rawRelease.seeders || 0;
  parsed.leechers = rawRelease.leechers || 0;
  parsed.size = rawRelease.size || '';
  parsed.uploader = rawRelease.uploader || '';
  parsed.magnet = rawRelease.magnet || '';

  const validation = validateRelease(parsed, media);
  if (!validation.valid) return null;

  const episodeStart = validation.episodeStart;
  const episodeEnd = validation.episodeEnd;
  const isBatch = isBatchRelease(rawRelease.name);

  let coverageType = CoverageType.UNKNOWN;
  let coveragePercent = 0;
  if (isBatch) {
    if (episodeStart !== null && episodeEnd !== null) {
      if (media.episodeCount && media.episodeCount > 0) {
        const total = media.episodeCount;
        coveragePercent = Math.min(100, Math.round(((episodeEnd - episodeStart + 1) / total) * 100));
        coverageType = coveragePercent >= 90 ? CoverageType.COMPLETE : CoverageType.PARTIAL;
      } else {
        coverageType = CoverageType.PARTIAL;
        coveragePercent = 50;
      }
    } else {
      coverageType = CoverageType.COMPLETE;
      coveragePercent = 100;
    }
  } else if (episodeStart !== null) {
    coverageType = CoverageType.SINGLE;
    coveragePercent = media.episodeCount ? Math.round((1 / media.episodeCount) * 100) : 0;
  }

  const confidence = calculateConfidence(parsed, media);
  const score = calculateScore(parsed, coverageType, coveragePercent, media);

  return {
    ...parsed,
    episodeStart,
    episodeEnd,
    isBatch,
    coverageType,
    coveragePercent,
    confidence,
    score
  };
}

module.exports = {
  parseReleaseName,
  extractEpisodeNumber,
  extractSeasonNumber,
  extractEpisodeRange,
  isBatchRelease,
  parseQuality,
  parseSource,
  getForbiddenTitles,
  getMediaSeason,
  validateRelease,
  calculateConfidence,
  calculateScore,
  processRelease
};
