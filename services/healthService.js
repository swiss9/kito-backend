const { TMDB_API_KEY, TORRENTCLAW_API_KEY } = require('../config');
const { kv } = require('@vercel/kv');

async function checkTmdb() {
  if (!TMDB_API_KEY) return 'missing_key';
  try {
    const res = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${TMDB_API_KEY}`, { signal: AbortSignal.timeout(5000) });
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
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        query: 'query { Page(perPage: 1) { media(type: ANIME) { id } } }'
      }),
      signal: AbortSignal.timeout(5000)
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
      headers: { 'User-Agent': 'KITO/1.0' }
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
      headers: { 'User-Agent': 'Mozilla/5.0' }
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
