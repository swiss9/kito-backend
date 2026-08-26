function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSeasonInfo(title) {
  return normalizeTitle(title)
    .replace(/\b(s\d+|season \d+|\d+(st|nd|rd|th) season|part \d+)\b/gi, '')
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

module.exports = {
  normalizeTitle,
  stripSeasonInfo,
  extractReleaseTitle,
  escapeRegex,
  wordBoundaryMatch,
  extractMagnetHash,
  getReleaseGroup
};
