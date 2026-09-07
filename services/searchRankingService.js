const { normalizeTitle, tokenSimilarity } = require('./titleService');
const { classifyWork, mapFormat } = require('./franchiseService');

const SEARCH_WEIGHTS = {
  exactTitle: 0.35,
  aliasMatch: 0.20,
  formatMatch: 0.15,
  yearMatch: 0.10,
  relationship: 0.15,
  popularity: 0.05
};

const ALIAS_SIMILARITY_THRESHOLD = 0.7;

function scoreCandidate(queryIntent, candidate) {
  let score = 0;

  const queryTitle = queryIntent.normalizedTitle;
  const candidateTitles = [candidate.title, ...(candidate.aliases || [])].map(normalizeTitle);

  const exactMatch = candidateTitles.some(t => t === queryTitle);
  if (exactMatch) {
    score += SEARCH_WEIGHTS.exactTitle;
  } else {
    const aliasMatch = candidateTitles.some(t => tokenSimilarity(t, queryTitle) > ALIAS_SIMILARITY_THRESHOLD);
    if (aliasMatch) score += SEARCH_WEIGHTS.aliasMatch;
  }

  if (queryIntent.requestedFormat && candidate.format) {
    const mappedFormat = mapFormat(candidate.format);
    if (mappedFormat === queryIntent.requestedFormat) {
      score += SEARCH_WEIGHTS.formatMatch;
    }
  } else if (!queryIntent.requestedFormat && candidate.mediaType === 'series') {
    score += SEARCH_WEIGHTS.formatMatch * 0.5;
  }

  if (queryIntent.requestedYear && candidate.year && candidate.year === queryIntent.requestedYear) {
    score += SEARCH_WEIGHTS.yearMatch;
  }

  const workClass = classifyWork(candidate, queryIntent);
  if (workClass.isMainWork) score += SEARCH_WEIGHTS.relationship;
  else if (workClass.relationshipType === 'SEQUEL' || workClass.relationshipType === 'PREQUEL') score += SEARCH_WEIGHTS.relationship * 0.5;
  else score += SEARCH_WEIGHTS.relationship * 0.1;

  if (candidate.popularity) {
    score += Math.min(candidate.popularity / 10000, 1) * SEARCH_WEIGHTS.popularity;
  }

  return Math.min(score, 1);
}

function deduplicateCandidates(candidates) {
  const seen = new Map();
  const results = [];
  for (const cand of candidates) {
    const key = cand.providerId ? `${cand.provider}:${cand.providerId}` : `${normalizeTitle(cand.title)}|${cand.year}|${cand.mediaType}`;
    if (!seen.has(key)) {
      seen.set(key, cand);
      results.push(cand);
    }
  }
  return results;
}

function rankSearchResults(queryIntent, candidates) {
  const deduped = deduplicateCandidates(candidates);
  const scored = deduped.map(c => ({ ...c, relevanceScore: scoreCandidate(queryIntent, c) }));
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const strong = scored.filter(c => c.relevanceScore >= 0.4);
  return strong;
}

module.exports = { rankSearchResults, scoreCandidate, deduplicateCandidates, SEARCH_WEIGHTS, ALIAS_SIMILARITY_THRESHOLD };
