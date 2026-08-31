async function httpGet(url, options = {}, { retries = 3, timeout = 8000 } = {}) {
  let lastError;
  let attempt = 1;
  while (attempt <= retries + 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal, method: 'GET' });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5');
        const waitMs = Math.min(retryAfter * 1000, 30000);
        console.warn(`HTTP GET ${url} received 429, waiting ${waitMs}ms (attempt ${attempt}/${retries + 1})`);
        await new Promise(r => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`HTTP GET ${url} failed (attempt ${attempt}/${retries + 1}): ${err.message}`);
      if (attempt <= retries) {
        const delay = Math.min(500 * attempt, 5000);
        await new Promise(r => setTimeout(r, delay));
      }
      attempt++;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function httpPost(url, body, options = {}, { retries = 2, timeout = 8000 } = {}) {
  let lastError;
  let attempt = 1;
  while (attempt <= retries + 1) {
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
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5');
        const waitMs = Math.min(retryAfter * 1000, 30000);
        console.warn(`HTTP POST ${url} received 429, waiting ${waitMs}ms (attempt ${attempt}/${retries + 1})`);
        await new Promise(r => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`HTTP POST ${url} failed (attempt ${attempt}/${retries + 1}): ${err.message}`);
      if (attempt <= retries) {
        const delay = Math.min(500 * attempt, 5000);
        await new Promise(r => setTimeout(r, delay));
      }
      attempt++;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

module.exports = { httpGet, httpPost };
