const { checkAnilist, checkTorrentclaw } = require('../services/healthService');

describe('healthService', () => {
  afterEach(() => jest.restoreAllMocks());

  test('checkAnilist uses POST and returns ok on 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await checkAnilist();
    expect(result).toBe('ok');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://graphql.anilist.co',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('checkAnilist returns error on non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await checkAnilist();
    expect(result).toBe('error');
  });

  test('checkTorrentclaw uses current /api/v1/search endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await checkTorrentclaw();
    expect(result).toBe('ok');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/search'),
      expect.anything()
    );
  });
});
