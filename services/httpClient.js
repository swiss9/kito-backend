const logger = require('./logger');

async function httpGet(url, options = {}) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(10000)
      });

      if (res.status === 404) {
        logger.debug({ url, status: res.status }, 'HTTP GET 404 â€“ skipping retries');
        return res;
      }

      if (res.ok) return res;
      if (res.status >= 500 && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function httpPost(url, body, options = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
    signal: options.signal || AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`HTTP POST ${res.status}: ${res.statusText}`);
  return res.json();
}

module.exports = { httpGet, httpPost };
