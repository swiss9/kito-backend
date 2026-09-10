const { rankReleases, selectBestCandidates } = require('../services/releaseRankingService');

const media = {
  title: 'Test Anime',
  aliases: ['Test Anime'],
  episodeCount: 12,
  totalEpisodeCount: 12,
  seasonEpisodeCount: 12,
  mediaType: 'series',
  seasonNumber: 1
};

const releases = [
  { name: 'Test Anime - 01 [1080p]', magnet: 'magnet:?xt=urn:btih:abc1', size: '500 MiB', seeders: 10 },
  { name: 'Test Anime - 01 [720p]', magnet: 'magnet:?xt=urn:btih:abc2', size: '300 MiB', seeders: 50 },
  { name: 'Test Anime - 01-12 [1080p]', magnet: 'magnet:?xt=urn:btih:abc3', size: '12 GiB', seeders: 100 }
];

describe('releaseRankingService', () => {
  test('complete season is preferred over individual episodes', () => {
    const ranked = rankReleases(media, releases, null);
    const selected = selectBestCandidates(ranked, media, null);
    expect(selected[0].coverageType).toBe('complete_season');
  });

  test('deduplicates identical releases', () => {
    const duplicate = [...releases, { name: 'Test Anime - 01 [1080p]', magnet: 'magnet:?xt=urn:btih:abc1', size: '500 MiB', seeders: 10 }];
    const ranked = rankReleases(media, duplicate, null);
    const unique = new Set(ranked.map(r => r.magnet)).size;
    expect(unique).toBe(releases.length);
  });
});
