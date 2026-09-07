const { normalizeTitle } = require('./titleService');

const FORMAT_KEYWORDS = {
  movie: 'movie',
  film: 'movie',
  ova: 'ova',
  ona: 'ona',
  special: 'special',
  tv: 'tv',
  series: 'tv'
};

const SEASON_PATTERNS = [
  /\bseason\s*(\d+)\b/i,
  /\bs(\d+)\b/i,
  /\bpart\s*(\d+)\b/i,
  /\bcour\s*(\d+)\b/i,
  /\b(\d+)(?:st|nd|rd|th)\s*season\b/i
];

const EPISODE_RANGE_PATTERN = /\b(\d{1,3})\s*[-â€“~]\s*(\d{1,3})\b/;
const EPISODE_PATTERNS = [
  /\bep(?:isode)?\s*(\d+)\b/i,
  /\be(\d{2,3})(?![0-9])\b/i,
  /\b#(\d+)\b/i,
  /\bepisode\s*(\d+)\b/i,
  /\bep\s*(\d+)\b/i
];

function parseQueryIntent(rawQuery) {
  const raw = rawQuery.trim();
  let remaining = raw;

  const intent = {
    normalizedTitle: '',
    requestedYear: null,
    requestedFormat: null,
    seasonNumber: null,
    episodeNumber: null,
    episodeRange: null,
    extraKeywords: []
  };

  const yearMatch = remaining.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    intent.requestedYear = parseInt(yearMatch[1]);
    remaining = remaining.replace(yearMatch[0], ' ').trim();
  }

  const formatMatch = remaining.match(/\b(movie|film|ova|ona|special|tv|series)\b/i);
  if (formatMatch) {
    intent.requestedFormat = FORMAT_KEYWORDS[formatMatch[1].toLowerCase()] || null;
    remaining = remaining.replace(formatMatch[0], ' ').trim();
  }

  for (const pat of SEASON_PATTERNS) {
    const match = remaining.match(pat);
    if (match) {
      intent.seasonNumber = parseInt(match[1]);
      remaining = remaining.replace(match[0], ' ').trim();
      break;
    }
  }

  const rangeMatch = remaining.match(EPISODE_RANGE_PATTERN);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1]);
    const end = parseInt(rangeMatch[2]);
    if (start > 0 && end > 0 && start < end && end < 1000) {
      intent.episodeRange = { start, end };
      remaining = remaining.replace(rangeMatch[0], ' ').trim();
    }
  }

  if (!intent.episodeRange) {
    for (const pat of EPISODE_PATTERNS) {
      const match = remaining.match(pat);
      if (match) {
        intent.episodeNumber = parseInt(match[1]);
        remaining = remaining.replace(match[0], ' ').trim();
        break;
      }
    }
  }

  intent.normalizedTitle = normalizeTitle(remaining);
  if (!intent.normalizedTitle) {
    intent.normalizedTitle = normalizeTitle(raw);
  }

  return intent;
}

module.exports = { parseQueryIntent };
