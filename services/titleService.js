const { normalizeTitle } = require('../utils');

function stripSeasonInfo(title) {
  return normalizeTitle(title)
    .replace(/\b(s\d+|season\s*\d+|\d+(st|nd|rd|th)\s*season|part\s*\d+|cour\s*\d+)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSimilarity(str1, str2) {
  const tokens1 = normalizeTitle(str1).split(' ');
  const tokens2 = normalizeTitle(str2).split(' ');
  if (!tokens1.length || !tokens2.length) return 0;
  const common = tokens1.filter(t => tokens2.includes(t)).length;
  return common / Math.max(tokens1.length, tokens2.length);
}

function isSameTitle(a, b) {
  return normalizeTitle(a) === normalizeTitle(b);
}

function extractYearFromTitle(title) {
  const match = normalizeTitle(title).match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1]) : null;
}

function extractSeasonFromTitle(title) {
  const clean = normalizeTitle(title);
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
    const match = clean.match(pat);
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

function extractEpisodeNumberFromTitle(title) {
  const clean = normalizeTitle(title);
  const patterns = [
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
      const num = parseInt(match[1]);
      if (num > 0 && num < 1000) return num;
    }
  }
  return null;
}

module.exports = {
  normalizeTitle,
  stripSeasonInfo,
  tokenSimilarity,
  isSameTitle,
  extractYearFromTitle,
  extractSeasonFromTitle,
  extractEpisodeNumberFromTitle
};
