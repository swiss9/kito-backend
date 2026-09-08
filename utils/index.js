const crypto = require('crypto');

function normalizeTitle(title) {
  if (!title) return '';
  return title
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSeasonInfo(title) {
  return normalizeTitle(title)
    .replace(/\b(s\d+|season\s*\d+|\d+(st|nd|rd|th)\s*season|part\s*\d+|cour\s*\d+)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReleaseTitle(name) {
  return name
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(1080p|720p|2160p|480p|360p|4k|8k|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit|Dual Audio|Multi Sub|Multi-Subs|Dual-Audio|VOSTFR|SUBFRENCH|READNFO)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBoundaryMatch(text, word) {
  return new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(text);
}

function extractMagnetHash(magnet) {
  const match = magnet.match(/btih:([a-fA-F0-9]+)/);
  return match ? match[1].toLowerCase() : null;
}

function getReleaseGroup(name) {
  const match = name.match(/\[([^\]]+)\]/);
  return match ? match[1] : null;
}

function isValidAdminToken(provided) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

module.exports = {
  normalizeTitle,
  stripSeasonInfo,
  extractReleaseTitle,
  escapeRegex,
  wordBoundaryMatch,
  extractMagnetHash,
  getReleaseGroup,
  isValidAdminToken
};
