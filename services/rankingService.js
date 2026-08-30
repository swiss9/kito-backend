const { normalizeTitle, extractReleaseTitle, escapeRegex, getReleaseGroup } = require('../utils');
const { CoverageType, MediaType, SEQUEL_KEYWORDS, TRUSTED_GROUPS } = require('../config');

const FORMAT_KEYWORDS = new Set(['movie', 'film', 'ova', 'special']);
const STOP_WORDS = new Set(['the', 'movie', 'film', 'ova', 'special', 'part', 'no', 'na', 'wa', 'to']);
const SEQUEL_MARKERS = ['shippuden', 'shippuuden', 'boruto', 'next generations', 'gt', 'z'];

function tokenize(title) {
  return normalizeTitle(title)
    .split(/\s+/)
    .filter(word => !STOP_WORDS.has(word) && word.length > 0);
}

function normalizeTitleForMatching(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getFranchise(media) {
  const norm = normalizeTitleForMatching(media.title);
  if (norm.includes('kamen rider') || norm.includes('masked rider')) return 'kamen rider';
  if (norm.includes('ultraman')) return 'ultraman';
  if (norm.includes('super sentai')) return 'super sentai';
  if (norm.includes('gundam')) return 'gundam';
  const parts = norm.split(/\s+/);
  return parts.length > 0 ? parts[0] : null;
}

function getCanonicalWorkName(media) {
  const titles = [media.title, ...(media.aliases || [])];
  for (const t of titles) {
    const norm = normalizeTitleForMatching(t);
    if (norm.includes('kamen rider') || norm.includes('masked rider')) {
      const riderIndex = norm.indexOf('rider');
      if (riderIndex !== -1) {
        let rest = norm.slice(riderIndex + 5).trim();
        rest = rest.replace(/^[\s:\-–—()]+/, '').replace(/[\s:\-–—()]+$/, '');
        if (rest.length > 0 && !/^\d{4}$/.test(rest)) {
          return rest;
        }
        if (/^\d{4}$/.test(rest)) {
          return '1971';
        }
      }
      const parts = norm.split(/\s+/);
      if (parts.length > 2) {
        const possible = parts.slice(2).join(' ');
        if (possible && possible.length > 0 && !/^\d{4}$/.test(possible)) {
          return possible;
        }
      }
      return null;
    }
  }
  return null;
}

function getAliases(media) {
  const aliases = [media.title, ...(media.aliases || [])].map(t => normalizeTitleForMatching(t));
  const result = [];
  const seen = new Set();
  for (const a of aliases) {
    if (!seen.has(a)) {
      seen.add(a);
      result.push(a);
    }
  }
  return result;
}

function getYear(media) {
  return media.year || null;
}

function getRelatedWorks(media) {
  const related = [];
  if (media.relations) {
    for (const rel of media.relations) {
      if (rel.title) {
        related.push(normalizeTitleForMatching(rel.title));
      }
    }
  }
  return related;
}

function hasOtherKamenRiderWork(releaseNorm, workName) {
  const workLower = workName ? workName.toLowerCase() : '';
  const otherWorks = [
    'geats', 'gaim', 'ex-aid', 'exaid', 'drive', 'build', 'ghost', 'kiva',
    'w', 'ooo', 'den-o', 'deno', 'hibiki', 'kabuto', 'blade', 'ryuki',
    'revice', 'saber', 'zero-one', 'zeroone', 'gotchard', 'gavv', 'decade',
    'agito', 'faiz', 'kuuga', 'fourze', 'wizard', 'zi-o', 'zio',
    'black', 'rx', 'stronger', 'skyrider', 'super 1', 'black rx'
  ];
  for (const other of otherWorks) {
    if (other === workLower) continue;
    if (releaseNorm.includes(other)) return true;
  }
  return false;
}

function extractEpisodeNumber(name) {
  if (!name) return null;
  const clean = name
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|360p|4k|8k)\b/gi, ' ')
    .replace(/\b(19\d\d|20\d\d)\b/g, ' ');
  const patterns = [
    /[Ss](\d+)[Ee](\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)/i,
    /[Ee](\d{2,3})(?![0-9])/,
    /Episode\s*(\d+)/i,
    /EP\s*(\d+)/i,
    /[Ee]P\s*(\d+)/i,
    /#(\d+)/
  ];
  for (const pat of patterns) {
    const match = clean.match(pat);
    if (match) {
      const num = parseInt(match[match.length - 1]);
      if (num > 0 && num < 1000) return num;
    }
  }
  const seasonEpisodeMatch = clean.match(/[Ss](\d+)[Ee](\d+)/);
  if (seasonEpisodeMatch) {
    const ep = parseInt(seasonEpisodeMatch[2]);
    if (ep > 0 && ep < 1000) return ep;
  }
  return null;
}

function extractSeasonNumber(name) {
  if (!name) return null;
  const romanMap = {
    'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6,
    'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
  };
  const seasonLabelPatterns = [
    /\bseason\s*(\d+)\b/i,
    /\bs(\d+)\b/i,
    /\b(\d+)(?:st|nd|rd|th)\s*season\b/i,
    /\bpart\s*(\d+)\b/i,
    /\bcour\s*(\d+)\b/i,
    /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*season\b/i,
    /\b(2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s*season\b/i,
    /\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/
  ];
  for (const pat of seasonLabelPatterns) {
    const match = name.match(pat);
    if (match) {
      const token = match[1] || match[0];
      if (/^\d+$/.test(token)) {
        const num = parseInt(token);
        if (num > 0 && num < 100) return num;
      } else {
        const lower = token.toLowerCase();
        if (lower in romanMap) return romanMap[lower.toUpperCase()];
        const wordMap = {
          'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
          'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10
        };
        if (lower in wordMap) return wordMap[lower];
      }
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
  const completePatterns = [
    /\bS(\d+)\s*Complete\b/i,
    /\bS(\d+)\s*(?:complete|full|all)\b/i,
    /\bComplete\s*S(\d+)\b/i,
    /\bSeason\s*(\d+)\s*Complete\b/i
  ];
  for (const pat of completePatterns) {
    const match = clean.match(pat);
    if (match) {
      const num = parseInt(match[1]);
      if (num > 0 && num < 100) return { start: null, end: null, season: num };
    }
  }
  return null;
}

function isBatchRelease(name, media) {
  const lower = name.toLowerCase();
  if (lower.includes('batch')) return true;
  if (lower.includes('complete series')) return true;
  if (lower.includes('full season')) return true;
  if (lower.includes('season pack')) return true;
  if (lower.includes('box set')) return true;
  const range = extractEpisodeRange(name);
  if (range && range.start !== null && range.end !== null) return true;
  const epCount = media && media.episodeCount ? media.episodeCount : 0;
  if (epCount > 0) {
    const season = extractSeasonNumber(name);
    if (season !== null) {
      const seasonRegex = new RegExp(`\\bS${season}\\b|\\bSeason\\s*${season}\\b`, 'i');
      if (seasonRegex.test(lower)) return true;
    }
  }
  return false;
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

function parseReleaseName(name) {
  const episode = extractEpisodeNumber(name);
  const season = extractSeasonNumber(name);
  const range = extractEpisodeRange(name);
  const releaseGroup = getReleaseGroup(name);
  const qualityInfo = parseQuality(name);
  const source = parseSource(name);
  const title = extractReleaseTitle(name);
  return { episodeNumber: episode, season, range, releaseGroup, quality: qualityInfo.quality, qualityLabel: qualityInfo.label, source, title };
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
  const normalizedMediaTitle = normalizeTitle(media.title).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const mediaFormat = (media.format || '').toUpperCase();
  for (const kw of SEQUEL_KEYWORDS) {
    const normalizedKw = normalizeTitle(kw).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (FORMAT_KEYWORDS.has(kw)) {
      const isSpecialFormat = ['MOVIE', 'OVA', 'ONA', 'SPECIAL', 'TV_SPECIAL', 'MUSIC', 'PV'].includes(mediaFormat);
      if (isSpecialFormat) continue;
    }
    if (!normalizedMediaTitle.includes(normalizedKw) && !forbidden.some(f => normalizeTitle(f).normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(normalizedKw))) {
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
  const releaseTitle = normalizeTitle(parsed.title || extractReleaseTitle(parsed.originalName))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const mediaTitles = [media.title, ...media.aliases]
    .map(t => normalizeTitle(t).normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
    .filter(Boolean);

  const reasons = [];
  let confidence = 0;
  let valid = false;

  const franchise = getFranchise(media);
  const workName = getCanonicalWorkName(media);
  const year = getYear(media);
  const aliases = getAliases(media);
  const related = getRelatedWorks(media);

  const releaseNorm = normalizeTitleForMatching(releaseTitle);

  let exactTitleMatch = false;
  for (const mt of mediaTitles) {
    if (releaseTitle.includes(mt)) {
      exactTitleMatch = true;
      confidence += 0.35;
      reasons.push('exact_title_match');
      break;
    }
  }

  if (!exactTitleMatch) {
    let aliasMatch = false;
    for (const alias of aliases) {
      if (releaseNorm.includes(alias)) {
        aliasMatch = true;
        confidence += 0.25;
        reasons.push('alias_match');
        break;
      }
    }
    if (!aliasMatch && workName && releaseNorm.includes(workName)) {
      confidence += 0.2;
      reasons.push('work_name_match');
    }
  }

  if (franchise && releaseNorm.includes(franchise)) {
    confidence += 0.05;
    reasons.push('franchise_match');
  } else if (franchise && !releaseNorm.includes(franchise)) {
    valid = false;
    reasons.push('no_franchise_match');
    return { valid: false, confidence: 0, reasons };
  }

  if (year && releaseNorm.includes(String(year))) {
    confidence += 0.05;
    reasons.push('year_match');
  }

  for (const rel of related) {
    if (releaseNorm.includes(rel)) {
      confidence += 0.05;
      reasons.push('related_work_match');
      break;
    }
  }

  if (franchise === 'kamen rider' && workName) {
    const hasOther = hasOtherKamenRiderWork(releaseNorm, workName);
    if (hasOther) {
      const isExact = mediaTitles.some(mt => releaseTitle.includes(mt));
      if (!isExact) {
        valid = false;
        reasons.push('other_kamen_rider_work');
        return { valid: false, confidence: 0, reasons };
      }
    }
  }

  const forbiddenTitles = getForbiddenTitles(media);
  for (const forb of forbiddenTitles) {
    if (releaseNorm.includes(forb)) {
      const mediaContainsForbidden = mediaTitles.some(mt => releaseNorm.includes(mt));
      if (!mediaContainsForbidden) {
        valid = false;
        reasons.push('forbidden_relation');
        return { valid: false, confidence: 0, reasons };
      }
    }
  }

  const releaseSeason = parsed.season ?? 1;
  const mediaSeason = getMediaSeason(media);
  if (releaseSeason !== mediaSeason) {
    const seasonStr = parsed.originalName ? normalizeTitle(parsed.originalName).normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
    const seasonPatterns = [
      /\b(season\s*0?[2-9]|s0?[2-9])\b/i,
      /\b(2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s*season\b/i,
      /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*season\b/i,
      /\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/
    ];
    if (mediaSeason === 1) {
      if (seasonPatterns.some(p => p.test(seasonStr))) {
        valid = false;
        reasons.push('season_mismatch');
        return { valid: false, confidence: 0, reasons };
      }
    } else {
      const seasonRegex = new RegExp(`\\b(season\\s*0?${mediaSeason}|s0?${mediaSeason})\\b`, 'i');
      const romanMap = { 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v' };
      const romanString = romanMap[mediaSeason] ? `\\b${romanMap[mediaSeason]}\\b` : null;
      let matchesSeason = seasonRegex.test(seasonStr);
      if (!matchesSeason && romanString) {
        matchesSeason = new RegExp(romanString, 'i').test(seasonStr);
      }
      if (!matchesSeason) {
        valid = false;
        reasons.push('season_mismatch');
        return { valid: false, confidence: 0, reasons };
      }
    }
  }

  const range = parsed.range;
  let episodeStart = null, episodeEnd = null;
  if (range && range.start !== null && range.end !== null) {
    episodeStart = range.start;
    episodeEnd = range.end;
  } else {
    const ep = parsed.episodeNumber;
    episodeStart = ep;
    episodeEnd = ep;
  }

  if (media.episodeCount && media.episodeCount > 0) {
    if (episodeStart !== null && episodeStart > media.episodeCount) {
      valid = false;
      reasons.push('episode_out_of_range');
      return { valid: false, confidence: 0, reasons };
    }
    if (episodeEnd !== null && episodeEnd > media.episodeCount) {
      valid = false;
      reasons.push('episode_out_of_range');
      return { valid: false, confidence: 0, reasons };
    }
  }

  valid = true;
  confidence = Math.min(confidence, 1);
  return { valid, confidence, reasons, episodeStart, episodeEnd };
}

function calculateConfidence(parsed, media) {
  const releaseTitle = normalizeTitle(parsed.title || extractReleaseTitle(parsed.originalName))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const mediaTitles = [media.title, ...media.aliases]
    .map(t => normalizeTitle(t).normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const exactTitleMatch = mediaTitles.some(mt => releaseTitle === mt);
  const isTrusted = TRUSTED_GROUPS.some(g => parsed.releaseGroup && parsed.releaseGroup.toLowerCase().includes(g.toLowerCase()));
  if (exactTitleMatch && isTrusted) return 'high';
  if (exactTitleMatch || isTrusted) return 'high';
  return 'medium';
}

function calculateScore(parsed, coverageType, coveragePercent, media, validation) {
  let score = 0;
  const confidence = validation.confidence || 0.5;
  score += confidence * 40;

  if (coverageType === CoverageType.COMPLETE) score += 30;
  else if (coverageType === CoverageType.PARTIAL) score += 15;
  else if (coverageType === CoverageType.SINGLE) score += 5;

  const quality = parsed.quality || 0;
  if (quality >= 1080) score += 15;
  else if (quality >= 720) score += 10;
  else if (quality >= 480) score += 5;

  const source = parsed.source || '';
  if (source === 'bluray') score += 10;
  else if (source === 'web-dl') score += 5;

  if (parsed.seeders > 100) score += 10;
  else if (parsed.seeders > 50) score += 5;

  const isTrusted = TRUSTED_GROUPS.some(g => parsed.releaseGroup && parsed.releaseGroup.toLowerCase().includes(g.toLowerCase()));
  if (isTrusted) score += 5;

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
  if (!validation.valid) {
    console.log(`[reject] ${rawRelease.name} -> ${validation.reasons.join(', ')}`);
    return null;
  }

  const episodeStart = validation.episodeStart;
  const episodeEnd = validation.episodeEnd;
  const isBatch = isBatchRelease(rawRelease.name, media);

  let coverageType = CoverageType.UNKNOWN;
  let coveragePercent = null;
  if (isBatch) {
    if (episodeStart !== null && episodeEnd !== null && media.episodeCount && media.episodeCount > 0) {
      const total = media.episodeCount;
      coveragePercent = Math.min(100, Math.round(((episodeEnd - episodeStart + 1) / total) * 100));
      coverageType = coveragePercent >= 90 ? CoverageType.COMPLETE : CoverageType.PARTIAL;
    } else if (episodeStart !== null && episodeEnd !== null) {
      coverageType = CoverageType.PARTIAL;
      coveragePercent = null;
    } else {
      const season = parsed.season;
      if (season !== null && media.episodeCount && media.episodeCount > 0) {
        coverageType = CoverageType.COMPLETE;
        coveragePercent = 100;
      } else {
        coverageType = CoverageType.COMPLETE;
        coveragePercent = 100;
      }
    }
  } else if (episodeStart !== null) {
    coverageType = CoverageType.SINGLE;
    coveragePercent = media.episodeCount && media.episodeCount > 0 ? Math.round((1 / media.episodeCount) * 100) : null;
  }

  const confidence = calculateConfidence(parsed, media);
  const score = calculateScore(parsed, coverageType, coveragePercent, media, validation);

  return {
    name: rawRelease.name,
    ...parsed,
    episodeStart,
    episodeEnd,
    isBatch,
    coverageType,
    coveragePercent,
    confidence,
    score,
    validation
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
  processRelease,
  getFranchise,
  getCanonicalWorkName,
  getAliases,
  getYear,
  getRelatedWorks
};
