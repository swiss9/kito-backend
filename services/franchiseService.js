const { normalizeTitle } = require('./titleService');

function getFranchise(media) {
  const norm = (media.title || '').toLowerCase();
  if (norm.includes('kamen rider') || norm.includes('masked rider')) return 'kamen rider';
  if (norm.includes('ultraman')) return 'ultraman';
  if (norm.includes('super sentai')) return 'super sentai';
  if (norm.includes('gundam')) return 'gundam';
  return null;
}

function mapFormat(providerFormat) {
  const fmt = providerFormat ? providerFormat.toUpperCase() : '';
  if (['TV', 'TV_SHORT'].includes(fmt)) return 'tv';
  if (fmt === 'MOVIE') return 'movie';
  if (fmt === 'OVA') return 'ova';
  if (fmt === 'ONA') return 'ona';
  if (fmt === 'SPECIAL') return 'special';
  return null;
}

function classifyWork(media, queryIntent) {
  if (!media) return { isMainWork: false, relationshipType: null, confidence: 0 };

  let isMainWork = false;
  let confidence = 0;

  if (queryIntent) {
    const titleMatch = normalizeTitle(media.title) === queryIntent.normalizedTitle ||
                       (media.aliases || []).some(a => normalizeTitle(a) === queryIntent.normalizedTitle);
    if (titleMatch) {
      isMainWork = true;
      confidence = 0.7;
    } else {
      isMainWork = false;
      confidence = 0.3;
    }

    if (queryIntent.requestedFormat && media.format) {
      const mappedFormat = mapFormat(media.format);
      if (mappedFormat === queryIntent.requestedFormat) {
        confidence += 0.1;
      }
    }
    if (queryIntent.requestedYear && media.year && media.year === queryIntent.requestedYear) {
      confidence += 0.1;
    }
  }

  return { isMainWork, relationshipType: null, confidence: Math.min(confidence, 1) };
}

module.exports = { getFranchise, classifyWork, mapFormat };
