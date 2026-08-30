const { normalizeTitle, extractReleaseTitle, escapeRegex, getReleaseGroup } = require('../utils');
const { CoverageType, MediaType, SEQUEL_KEYWORDS, TRUSTED_GROUPS } = require('../config');

const FORMAT_KEYWORDS = new Set(['movie', 'film', 'ova', 'special']);
const STOP_WORDS = new Set(['the', 'movie', 'film', 'ova', 'special', 'part', 'no', 'na', 'wa', 'to']);
const SEQUEL_MARKERS = ['shippuden', 'shippuuden', 'boruto', 'next generations', 'gt', 'z'];

const OTHER_SERIES = [
  'geats', 'gaim', 'ex-aid', 'exaid', 'drive', 'build', 'ghost', 'kiva',
  'w', 'ooo', 'den-o', 'deno', 'hibiki', 'kabuto', 'blade', 'ryuki',
  'revice', 'saber', 'zero-one', 'zeroone', 'gotchard', 'gavv', 'decade',
  'agito', 'faiz', 'kuuga', 'fourze', 'wizard', 'zi-o', 'zio',
  'black', 'rx', 'stronger', 'skyrider', 'super 1', 'black rx',
  'outsiders', 'shin', 'girls', 'amazons', 'amazon'
];

function tokenize(title) {
  return normalizeTitle(title)
    .split(/\s+/)
    .filter(word => !STOP_WORDS.has(word) && word.length > 0);
}

function getCanonicalSeriesName(media) {
  const norm = normalizeTitle(media.title);
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
    return 'unknown';
  }
  return null;
}

function containsOtherSeries(releaseTitle, excludeSeries) {
  const lower = releaseTitle.toLowerCase();
  const exclude = excludeSeries ? excludeSeries.toLowerCase() : '';
  for (const series of OTHER_SERIES) {
    if (series.toLowerCase() === exclude) continue;
    const regex = new RegExp(`\\b${escapeRegex(series)}\\b`, 'i');
    if (regex.test(lower)) return true;
  }
  return false;
}

function titleMatches(releaseTitle, mediaTitles, mediaSeason = null, mediaFormat = null, media = null) {
  const releaseLower = releaseTitle.toLowerCase();

  if (media && media.title) {
    const mediaLower = media.title.toLowerCase();
    const isShippuden = mediaLower.includes('shippuden') || mediaLower.includes('shippuuden');
    const isBoruto = mediaLower.includes('boruto');
    const isOriginal = !isShippuden && !isBoruto;
    if (isOriginal) {
      for (const marker of SEQUEL_MARKERS) {
        if (releaseLower.includes(marker)) return false;
      }
    }

    const seriesName = getCanonicalSeriesName(media);
    const isKamenRider = mediaLower.includes('kamen rider') || mediaLower.includes('masked rider');

    if (isKamenRider) {
      console.log(`[titleMatches] Media: "${media.title}", seriesName: "${seriesName}"`);

      if (seriesName === '1971') {
        if (releaseLower.includes('1971')) {
          if (!containsOtherSeries(releaseTitle, '1971')) {
            console.log(`[titleMatches] ACCEPT 1971: ${releaseTitle}`);
            return true;
          }
          console.log(`[titleMatches] REJECT 1971 (other series): ${releaseTitle}`);
          return false;
        }
        console.log(`[titleMatches] REJECT 1971 (no year): ${releaseTitle}`);
        return false;
      }

      if (seriesName && seriesName !== 'unknown') {
        const seriesRegex = new RegExp(escapeRegex(seriesName), 'i');
        if (seriesRegex.test(releaseTitle)) {
          console.log(`[titleMatches] ACCEPT (series match "${seriesName}"): ${releaseTitle}`);
          return true;
        }
        console.log(`[titleMatches] REJECT (series mismatch - looking for "${seriesName}"): ${releaseTitle}`);
        return false;
      }

      if (releaseLower.includes('kamen rider') || releaseLower.includes('masked rider')) {
        if (!containsOtherSeries(releaseTitle, null)) {
          console.log(`[titleMatches] ACCEPT (fallback): ${releaseTitle}`);
          return true;
        }
        console.log(`[titleMatches] REJECT (contains other series): ${releaseTitle}`);
        return false;
      }
    }
  }

  for (const mt of mediaTitles) {
    if (!mt) continue;
    const normalizedMedia = normalizeTitle(mt);
    if (releaseTitle.includes(normalizedMedia)) return true;
  }

  const releaseTokens = tokenize(releaseTitle);
  const releaseSet = new Set(releaseTokens);

  for (const mt of mediaTitles) {
    if (!mt) continue;
    const mediaTokens = tokenize(mt);
    if (mediaTokens.length === 0) continue;
    const allPresent = mediaTokens.every(token => releaseSet.has(token));
    if (allPresent) return true;
  }

  return false;
}

function parseReleaseName(name) {
  const episode = extractEpisodeNumber(name);
  const season = extractSeasonNumber(name, { hasEpisode: episode !== null });
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
    /\((\d+)\)/,
    /[Ee]P\s*(\d+)/i,
    /EP\s*(\d+)/i,
    /Episode\s*(\d+)/i,
    /E(\d{2,3})(?=[\s\]])/i
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

function extractSeasonNumber(name, { hasEpisode = false } = {}) {
  if (!name) return null;
  const romanMap = {
    'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6,
    'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
  };

  const seasonLabelPatterns = [
    /\b(\d+)(?:st|nd|rd|th)\s*season\b/i,
    /\bseason\s*(\d+)\b/i,
    /\bs(\d+)\b/i,
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

  const clean = name.replace(/\[.*?\]|\(.*?\)/g, ' ');
  const ordinalMatch = clean.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  if (ordinalMatch) return parseInt(ordinalMatch[1]);
  const romanMatch = clean.match(/\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/);
  if (romanMatch) return romanMap[romanMatch[1].toUpperCase()];
  const patterns = [
    /[Ss](\d+)[Ee]\d+/,
    /[Ss]eason\s*(\d+)/i,
    /S(\d+)\s*Complete/i
  ];
  if (!hasEpisode) {
    patterns.push(/\b(\d+)$/);
  }
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

  const mediaSeason = getMediaSeason(media);
  if (!titleMatches(releaseTitle, mediaTitles, mediaSeason, media.format, media)) {
    console.log(`[reject] ${parsed.originalName} -> title_mismatch`);
    return { valid: false, reason: 'title_mismatch' };
  }

  const forbiddenTitles = getForbiddenTitles(media);
  for (const forb of forbiddenTitles) {
    if (!forb) continue;
    const forbRegex = new RegExp(`\\b${escapeRegex(forb)}\\b`, 'i');
    if (forbRegex.test(releaseTitle)) {
      const mediaContainsForbidden = mediaTitles.some(mt => forbRegex.test(mt));
      if (!mediaContainsForbidden) {
        console.log(`[reject] ${parsed.originalName} -> forbidden_relation`);
        return { valid: false, reason: 'forbidden_relation' };
      }
    }
  }

  const releaseSeason = parsed.season ?? 1;
  if (releaseSeason !== mediaSeason) {
    if (mediaSeason === 1) {
      const relTitleNorm = normalizeTitle(parsed.originalName).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const seasonPatterns = [
        /\b(season\s*0?[2-9]|s0?[2-9])\b/i,
        /\b(2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s*season\b/i,
        /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*season\b/i,
        /\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/
      ];
      if (seasonPatterns.some(p => p.test(relTitleNorm))) {
        console.log(`[reject] ${parsed.originalName} -> season_mismatch`);
        return { valid: false, reason: 'season_mismatch' };
      }
    } else {
      const relTitleNorm = normalizeTitle(parsed.originalName).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const seasonRegex = new RegExp(`\\b(season\\s*0?${mediaSeason}|s0?${mediaSeason})\\b`, 'i');
      const romanMap = { 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v' };
      const romanString = romanMap[mediaSeason] ? `\\b${romanMap[mediaSeason]}\\b` : null;
      let matchesSeason = seasonRegex.test(relTitleNorm);
      if (!matchesSeason && romanString) {
        matchesSeason = new RegExp(romanString, 'i').test(relTitleNorm);
      }
      if (!matchesSeason) {
        console.log(`[reject] ${parsed.originalName} -> season_mismatch`);
        return { valid: false, reason: 'season_mismatch' };
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
    if (episodeStart !== null && episodeStart > media.episodeCount) {
      console.log(`[reject] ${parsed.originalName} -> episode_out_of_range`);
      return { valid: false, reason: 'episode_out_of_range' };
    }
    if (episodeEnd !== null && episodeEnd > media.episodeCount) {
      console.log(`[reject] ${parsed.originalName} -> episode_out_of_range`);
      return { valid: false, reason: 'episode_out_of_range' };
    }
  }

  return { valid: true, episodeStart, episodeEnd };
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
    name: rawRelease.name,
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
