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
  const maxRetries = 2;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: options.signal || AbortSignal.timeout(10000)
      });
      if (!res.ok) {
        const err = new Error(`HTTP POST ${res.status}: ${res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && err.status !== 429 && err.status !== 400) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

module.exports = { httpGet, httpPost };
