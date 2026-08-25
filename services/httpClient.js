const pRetry = require('p-retry');

async function httpGet(url, options = {}, { retries = 3, timeout = 8000 } = {}) {
  return pRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { ...options, signal: controller.signal, method: 'GET' });
        if (!res.ok) {
          throw new pRetry.AbortError(`HTTP ${res.status}`);
        }
        return res;
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new pRetry.AbortError('Timeout');
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      retries,
      onFailedAttempt: error => {
        console.warn(`HTTP GET ${url} failed (attempt ${error.attemptNumber}/${retries + 1}): ${error.message}`);
      },
    }
  );
}

async function httpPost(url, body, options = {}, { retries = 2, timeout = 8000 } = {}) {
  return pRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          ...options,
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new pRetry.AbortError(`HTTP ${res.status}`);
        }
        return res;
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new pRetry.AbortError('Timeout');
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      retries,
      onFailedAttempt: error => {
        console.warn(`HTTP POST ${url} failed (attempt ${error.attemptNumber}/${retries + 1}): ${error.message}`);
      },
    }
  );
}

module.exports = { httpGet, httpPost };
