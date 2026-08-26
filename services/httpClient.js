async function httpGet(url, options = {}, { retries = 3, timeout = 8000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal, method: 'GET' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`HTTP GET ${url} failed (attempt ${attempt}/${retries + 1}): ${err.message}`);
      if (attempt <= retries) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function httpPost(url, body, options = {}, { retries = 2, timeout = 8000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
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
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`HTTP POST ${url} failed (attempt ${attempt}/${retries + 1}): ${err.message}`);
      if (attempt <= retries) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

module.exports = { httpGet, httpPost };
