const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TORRENTCLAW_API_KEY = process.env.TORRENTCLAW_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

const SEQUEL_KEYWORDS = [
  'shippuden', 'shippuuden', 'boruto', 'next generations',
  'rock lee', 'movie', 'film', 'ova', 'special', 'spin-off', 'spin off'
];

const TRUSTED_GROUPS = [
  'SubsPlease', 'Erai-raws', 'Judas', 'AnimeRG',
  'HorribleSubs', 'Asenshi', 'Commie', 'FFFpeeps',
  'GJM', 'Hatsuyuki', 'Kaleido', 'Kamigami', 'Leopard',
  'Mabuse', 'Mazui', 'Nekomoe', 'Ohys', 'ReinForce',
  'SallySubs', 'SSA', 'Tatsumi', 'Underwater', 'Vivid',
  'Yami', 'ZR'
];

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
  categoryConfig
};
