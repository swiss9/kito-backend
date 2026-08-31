const { calculateScore, processRelease } = require('../services/rankingService');
const { CoverageType } = require('../config');

describe('rankingService', () => {
  test('calculateScore returns high score for complete coverage', () => {
    const parsed = { quality: 1080, source: 'bluray', seeders: 150, releaseGroup: 'SubsPlease' };
    const validation = { confidence: 0.95 };
    const score = calculateScore(parsed, CoverageType.COMPLETE, 100, {}, validation);
    expect(score).toBeGreaterThan(80);
  });

  test('calculateScore returns lower score for single episodes', () => {
    const parsed = { quality: 720, source: 'web-dl', seeders: 30 };
    const validation = { confidence: 0.5 };
    const score = calculateScore(parsed, CoverageType.SINGLE, 5, { episodeCount: 20 }, validation);
    expect(score).toBeLessThan(60);
  });

  test('calculateScore gives bonus for trusted groups', () => {
    const parsed = { quality: 1080, source: 'bluray', seeders: 50, releaseGroup: 'SubsPlease' };
    const validation = { confidence: 0.8 };
    const score = calculateScore(parsed, CoverageType.COMPLETE, 100, {}, validation);
    expect(score).toBeGreaterThan(70);
  });

  test('processRelease returns null for invalid releases', () => {
    const invalidRelease = {
      name: 'Some Random Release',
      magnet: 'magnet:?xt=urn:btih:test',
      seeders: 10,
    };
    const media = {
      title: 'Naruto',
      aliases: ['Naruto'],
      episodeCount: 220
    };
    const result = processRelease(invalidRelease, media);
    expect(result).toBeNull();
  });
});
