const { normalizeTitle, tokenSimilarity } = require('./titleService');

function getFranchiseKey(media) {
  if (!media) return null;
  if (media.parentId) return `parent:${media.parentId}`;
  if (media.franchiseId) return `franchise:${media.franchiseId}`;
  if (media.relations && media.relations.length) {
    const mainRel = media.relations.find(r => r.relationType === 'MAIN' || r.relationType === 'PARENT');
    if (mainRel && mainRel.node) return `provider:${mainRel.node.id}`;
  }
  return null;
}

function getTitleIdentityFallback(media) {
  return media && media.title ? normalizeTitle(media.title) : null;
}

function classifyWork(media, queryIntent) {
  if (!media) return { isMainWork: false, relationshipType: null, confidence: 0 };

  const relationshipType = media.relationType || null;
  let isMainWork = false;
  let confidence = 0;

  if (relationshipType) {
    if (['SEQUEL', 'PREQUEL', 'SPIN_OFF', 'SIDE_STORY', 'ALTERNATIVE', 'SUMMARY', 'SPECIAL'].includes(relationshipType)) {
      isMainWork = false;
      confidence = 0.8;
    } else if (relationshipType === 'MAIN' || relationshipType === 'PARENT') {
      isMainWork = !media.parentId && !media.franchiseId;
      confidence = isMainWork ? 0.9 : 0.5;
    }
  }

  if (!relationshipType && queryIntent) {
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

  return { isMainWork, relationshipType, confidence: Math.min(confidence, 1) };
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

function getFranchise(media) {
  const norm = (media.title || '').toLowerCase();
  if (norm.includes('kamen rider') || norm.includes('masked rider')) return 'kamen rider';
  if (norm.includes('ultraman')) return 'ultraman';
  if (norm.includes('super sentai')) return 'super sentai';
  if (norm.includes('gundam')) return 'gundam';
  return null;
}

module.exports = { getFranchiseKey, getTitleIdentityFallback, classifyWork, mapFormat, getFranchise };
