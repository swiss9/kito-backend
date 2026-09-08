const logger = require('./logger');

async function httpGet(url, options = {}) {
  const maxRetries = options.maxRetries ?? 1;
  const timeoutMs = options.timeoutMs ?? 5000;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(timeoutMs)
      });

      if ([400, 401, 403, 404, 429].includes(res.status)) {
        logger.debug({ url, status: res.status }, 'HTTP GET non-retryable status');
        return res;
      }

      if (res.ok) return res;

      if (res.status >= 500 && attempt < maxRetries) {
        const delay = Math.min(500 * Math.pow(2, attempt), 3000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        logger.warn({ url, timeoutMs, error: err.name }, 'HTTP GET timeout or abort');
      }
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(500 * Math.pow(2, attempt), 3000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function httpPost(url, body, options = {}) {
  const maxRetries = options.maxRetries ?? 1;
  const timeoutMs = options.timeoutMs ?? 5000;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: options.signal || AbortSignal.timeout(timeoutMs)
      });
      if (res.ok) return res.json();
      const err = new Error(`HTTP POST ${res.status}: ${res.statusText}`);
      err.status = res.status;
      throw err;
    } catch (err) {
      lastError = err;
      if (err.status && err.status >= 400 && err.status < 500) {
        throw err;
      }
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(500 * Math.pow(2, attempt), 3000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

module.exports = { httpGet, httpPost };
