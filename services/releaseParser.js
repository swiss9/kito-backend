function parseReleaseName(name) {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  const episodeInfo = extractEpisodeInfo(cleaned);
  const season = extractSeasonNumber(cleaned);
  const quality = parseQuality(cleaned);
  const source = parseSource(cleaned);
  const codec = parseCodec(cleaned);
  const resolution = parseResolution(cleaned);
  const title = extractReleaseTitle(cleaned);
  const group = getReleaseGroup(name);
  return {
    originalName: name,
    title,
    season,
    episodeInfo,
    quality: quality.quality,
    qualityLabel: quality.label,
    source,
    codec,
    resolution,
    group
  };
}

function extractEpisodeInfo(name) {
  const range = extractEpisodeRange(name);
  if (range) {
    return { type: 'range', start: range.start, end: range.end };
  }
  const ep = extractEpisodeNumber(name);
  if (ep) {
    return { type: 'single', start: ep, end: ep };
  }
  return null;
}

function extractReleaseTitle(name) {
  let title = name
    .replace(/\[.*?\]/g, ' ')
    .replace(/\b(1080p|720p|2160p|480p|360p|4k|8k|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit|Dual Audio|Multi Sub|Multi-Subs|Dual-Audio|VOSTFR|SUBFRENCH|READNFO)\b/gi, ' ')
    .replace(/\bseason\s*\d+\b/gi, '')
    .replace(/\bs\d+\b/gi, '')
    .replace(/\bep(?:isode)?\s*\d+\b/gi, '')
    .replace(/\be\d{2,3}\b/gi, '')
    .replace(/\b\d{1,3}\s*[-â€“~]\s*\d{1,3}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  title = title.replace(/\((?:1080p|720p|2160p|480p|360p|4k|8k|WEB-DL|WEBRip|BluRay|x264|x265|HEVC|HDR|10bit|Dual Audio|Multi Sub|Multi-Subs|Dual-Audio|VOSTFR|SUBFRENCH|READNFO)\)/gi, ' ');
  return title.replace(/\s+/g, ' ').trim();
}

function extractEpisodeNumber(name) {
  const patterns = [
    /\b[Ee]p(?:isode)?\s*(\d+)\b/i,
    /\b[Ee](\d{2,3})(?!\d)\b/i,
    /\bEpisode\s*(\d+)\b/i,
    /\bEP\s*(\d+)\b/i,
    /\b[Ee]P\s*(\d+)\b/i,
    /\b#(\d+)\b/i,
    /\s-\s(\d{1,3})(?![0-9])/
  ];
  for (const pat of patterns) {
    const match = name.match(pat);
    if (match) {
      const num = parseInt(match[1]);
      if (num > 0 && num < 1000) return num;
    }
  }
  return null;
}

function extractSeasonNumber(name) {
  const patterns = [
    /\bseason\s*(\d+)\b/i,
    /\bs(\d+)\b/i,
    /\bpart\s*(\d+)\b/i,
    /\bcour\s*(\d+)\b/i,
    /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*season\b/i,
    /\b(\d+)(?:st|nd|rd|th)\s*season\b/i,
    /\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/
  ];
  for (const pat of patterns) {
    const match = name.match(pat);
    if (match) {
      const token = match[1] || match[0];
      const num = parseInt(token);
      if (!isNaN(num) && num > 0 && num < 100) return num;
      const lower = token.toLowerCase();
      const romanMap = { 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10 };
      if (romanMap[lower]) return romanMap[lower];
      const wordMap = { 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5, 'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10 };
      if (wordMap[lower]) return wordMap[lower];
    }
  }
  return null;
}

function extractEpisodeRange(name) {
  const patterns = [
    /(\d+)\s*[-â€“~]\s*(\d+)/,
    /[Ee]p(?:isode)?\s*(\d+)\s*[-â€“~]\s*(\d+)/i,
    /[Ee](\d+)\s*[-â€“~]\s*[Ee]?(\d+)/
  ];
  for (const pat of patterns) {
    const match = name.match(pat);
    if (match) {
      const start = parseInt(match[1]);
      const end = parseInt(match[2]);
      if (start > 0 && end > 0 && start < end && end < 1000) return { start, end };
    }
  }
  return null;
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

function parseCodec(name) {
  const match = name.match(/\b(x264|x265|HEVC|H\.264|H\.265)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function parseResolution(name) {
  const match = name.match(/\b(2160p|1080p|720p|480p|360p|4k)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function getReleaseGroup(name) {
  const match = name.match(/\[([^\]]+)\]/);
  return match ? match[1] : null;
}

module.exports = {
  parseReleaseName,
  extractEpisodeInfo,
  extractReleaseTitle,
  extractEpisodeNumber,
  extractSeasonNumber,
  extractEpisodeRange,
  parseQuality,
  parseSource,
  parseCodec,
  parseResolution,
  getReleaseGroup
};
