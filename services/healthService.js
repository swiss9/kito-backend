const { TMDB_API_KEY, TORRENTCLAW_API_KEY } = require('../config');
const { kv } = require('@vercel/kv');
const logger = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function checkTmdb() {
  if (!TMDB_API_KEY) return 'missing_key';
  try {
    const res = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${TMDB_API_KEY}`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': USER_AGENT }
    });
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'timeout';
  }
}

async function checkAnilist() {
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify({
        query: 'query { Media(id: 1) { id } }'
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (res.status === 429) return 'rate_limited';
    if (res.ok) return 'ok';
    logger.warn({ status: res.status }, 'AniList health check returned non-ok status');
    return 'error';
  } catch (err) {
    logger.warn({ err }, 'AniList health check failed');
    return 'timeout';
  }
}

async function checkTorrentclaw() {
  if (!TORRENTCLAW_API_KEY) return 'missing_key';
  try {
    const params = new URLSearchParams({ q: 'test', category: 'all', limit: '1' });
    params.append('apikey', TORRENTCLAW_API_KEY);
    const url = `https://torrentclaw.com/api/v1/search?${params.toString()}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': USER_AGENT }
    });
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'timeout';
  }
}

async function checkNyaa() {
  try {
    const res = await fetch('https://nyaa.si/?page=rss&c=1_2&q=test', {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': USER_AGENT }
    });
    if (res.status === 429) return 'rate_limited';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'timeout';
  }
}

async function checkKv() {
  try {
    await kv.set('health:ping', 'pong', { ex: 10 });
    const result = await kv.get('health:ping');
    return result === 'pong' ? 'ok' : 'error';
  } catch {
    return 'timeout';
  }
}

module.exports = { checkTmdb, checkAnilist, checkTorrentclaw, checkNyaa, checkKv };
