const { normalizeTitle } = require('../utils');

function tokenSimilarity(str1, str2) {
  const tokens1 = normalizeTitle(str1).split(/\s+/).filter(Boolean);
  const tokens2 = normalizeTitle(str2).split(/\s+/).filter(Boolean);
  if (tokens1.length === 0 || tokens2.length === 0) return 0;
  const common = tokens1.filter(t => tokens2.includes(t)).length;
  return common / Math.max(tokens1.length, tokens2.length);
}

module.exports = { normalizeTitle, tokenSimilarity };
