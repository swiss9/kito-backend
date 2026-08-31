const { getCache, setCache, deleteCache, clearAllCache } = require('../services/cacheService');

jest.mock('@vercel/kv', () => ({
  kv: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    flushdb: jest.fn(),
  }
}));

const { kv } = require('@vercel/kv');

describe('cacheService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KV_REST_API_URL = 'http://test';
    process.env.KV_REST_API_TOKEN = 'test';
  });

  afterEach(() => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  test('getCache returns value from KV', async () => {
    const mockData = { test: 'data' };
    kv.get.mockResolvedValue(JSON.stringify(mockData));

    const result = await getCache('test-key');
    expect(result).toEqual(mockData);
    expect(kv.get).toHaveBeenCalledWith('test-key');
  });

  test('getCache falls back to memory when KV fails', async () => {
    kv.get.mockRejectedValue(new Error('KV error'));

    const result = await getCache('test-key');
    expect(result).toBeNull();
  });

  test('setCache writes to KV', async () => {
    const data = { test: 'data' };
    await setCache('test-key', data, 3600);

    expect(kv.set).toHaveBeenCalledWith('test-key', JSON.stringify(data), { ex: 3600 });
  });

  test('setCache falls back to memory when KV fails', async () => {
    kv.set.mockRejectedValue(new Error('KV error'));

    const data = { test: 'data' };
    await setCache('test-key', data, 3600);

    const result = await getCache('test-key');
    expect(result).toEqual(data);
  });

  test('deleteCache removes from KV', async () => {
    await deleteCache('test-key');
    expect(kv.del).toHaveBeenCalledWith('test-key');
  });

  test('clearAllCache disabled in production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(clearAllCache()).rejects.toThrow('flushdb is disabled in production');
    delete process.env.NODE_ENV;
  });
});
