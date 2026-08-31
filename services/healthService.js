const { TMDB_API_KEY } = require('../config');
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(5000)
    });
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'timeout';
  }
}

async function checkTorrentclaw() {
  try {
    const res = await fetch('https://torrentclaw.com/api/search?q=test&limit=1', { signal: AbortSignal.timeout(5000) });
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

module.exports = { checkTmdb, checkAnilist, checkTorrentclaw, checkKv };
