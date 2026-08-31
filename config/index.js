const fs = require('fs');
const path = require('path');

const constantsPath = path.join(__dirname, 'constants.json');
const constants = JSON.parse(fs.readFileSync(constantsPath, 'utf8'));

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TORRENTCLAW_API_KEY = process.env.TORRENTCLAW_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const requiredEnv = ['TMDB_API_KEY', 'TORRENTCLAW_API_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (!GROQ_API_KEY) {
  console.warn('GROQ_API_KEY is not set. AI features (recommendations, AI search) will be disabled.');
}

const CoverageType = {
  SINGLE: 'single',
  PARTIAL: 'partial',
  COMPLETE: 'complete',
  COLLECTION: 'collection',
  UNKNOWN: 'unknown'
};

const MediaType = {
  MOVIE: 'movie',
  SERIES: 'series'
};

const SEQUEL_KEYWORDS = constants.SEQUEL_KEYWORDS;
const TRUSTED_GROUPS = constants.TRUSTED_GROUPS;
const OTHER_SERIES = constants.OTHER_SERIES;
const ALIAS_MAP = constants.ALIAS_MAP || {};
const QUERY_CORRECTIONS = constants.QUERY_CORRECTIONS || {};

const categoryConfig = {
  anime: {
    id: 'anime',
    metadataProvider: 'anilist',
    mediaType: MediaType.SERIES,
    torrentSources: ['nyaa_rss', 'torrentclaw']
  },
  tokusatsu: {
    id: 'tokusatsu',
    metadataProvider: 'tmdb',
    mediaType: MediaType.SERIES,
    torrentSources: ['nyaa_rss', 'torrentclaw']
  }
};

module.exports = {
  TMDB_API_KEY,
  TORRENTCLAW_API_KEY,
  GROQ_API_KEY,
  CoverageType,
  MediaType,
  SEQUEL_KEYWORDS,
  TRUSTED_GROUPS,
  OTHER_SERIES,
  ALIAS_MAP,
  QUERY_CORRECTIONS,
  categoryConfig
};
