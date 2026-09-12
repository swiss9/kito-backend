const { TMDB_API_KEY, TORRENTCLAW_API_KEY } = require('../config');
const { kv } = require('@vercel/kv');
const logger = require('./logger');

const USER_AGENT = 'KITO/1.0';

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

async function checkShikimori() {
  try {
    const res = await fetch('https://shikimori.one/api/animes?limit=1', {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': USER_AGENT }
    });
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'timeout';
  }
}

async function checkKitsu() {
  try {
    const res = await fetch('https://kitsu.io/api/edge/anime?filter[text]=naruto&page[limit]=1', {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/vnd.api+json' }
    });
    return res.ok ? 'ok' : 'error';
  } catch {
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

module.exports = { checkTmdb, checkShikimori, checkKitsu, checkTorrentclaw, checkNyaa, checkKv };
