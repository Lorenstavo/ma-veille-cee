import https from "node:https";

export const COUR_DES_COMPTES_TIMEOUT_MS = 30_000;
export const COUR_DES_COMPTES_MAX_ATTEMPTS = 2;
export const COUR_DES_COMPTES_RETRY_DELAY_MS = 1_500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// Future architecture only: https://www.ccomptes.fr/rss/publications is an
// official general feed. It is intentionally not used here: CEE filtering and
// publication extraction require a dedicated, separately validated adapter.

function makeError(message, code, cause) {
  const error = new Error(message);
  if (code) error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function isTemporaryCourDesComptesError(error) {
  return /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)$/i.test(error?.code || "");
}

function normaliseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value ?? null]));
}

async function requestViaHttps({ url, headers, timeoutMs, family, rejectUnauthorized, redirects = 0 }) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw makeError("Cour des comptes redirect is not HTTPS", "ERR_INVALID_PROTOCOL");

  return new Promise((resolve, reject) => {
    const request = https.request(parsedUrl, {
      method: "GET",
      headers,
      family,
      rejectUnauthorized,
      timeout: timeoutMs
    }, response => {
      const statusCode = response.statusCode || 0;
      const responseHeaders = normaliseHeaders(response.headers);
      const location = responseHeaders.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(makeError("Too many Cour des comptes redirects", "ERR_TOO_MANY_REDIRECTS"));
          return;
        }
        let nextUrl;
        try { nextUrl = new URL(location, parsedUrl).toString(); } catch {
          reject(makeError("Invalid Cour des comptes redirect", "ERR_INVALID_REDIRECT"));
          return;
        }
        requestViaHttps({ url: nextUrl, headers, timeoutMs, family, rejectUnauthorized, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }

      const contentLength = Number(responseHeaders["content-length"] || 0);
      if (contentLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(makeError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`, "ERR_RESPONSE_TOO_LARGE"));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on("data", chunk => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) response.destroy(makeError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`, "ERR_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ statusCode, headers: responseHeaders, body: Buffer.concat(chunks), url: parsedUrl.toString() }));
    });

    request.on("timeout", () => request.destroy(makeError(`Request timeout after ${timeoutMs}ms`, "ETIMEDOUT")));
    request.on("error", reject);
    request.end();
  });
}

async function checkOnce({ url, headers, timeoutMs, requestImpl }) {
  const response = await requestImpl({ url, headers, timeoutMs, family: 4, rejectUnauthorized: true });
  if (response.statusCode < 200 || response.statusCode >= 300) throw makeError(`HTTP ${response.statusCode}`, `HTTP_${response.statusCode}`);
  if (!Buffer.isBuffer(response.body)) throw makeError("Cour des comptes response body is invalid", "ERR_INVALID_RESPONSE");
  return {
    finalUrl: response.url || url,
    etag: response.headers?.etag || null,
    lastModified: response.headers?.["last-modified"] || null,
    body: response.body
  };
}

export async function checkCourDesComptes({
  url,
  headers,
  timeoutMs = COUR_DES_COMPTES_TIMEOUT_MS,
  maxAttempts = COUR_DES_COMPTES_MAX_ATTEMPTS,
  retryDelayMs = COUR_DES_COMPTES_RETRY_DELAY_MS,
  requestImpl = requestViaHttps,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onAttempt = () => {},
  onRetry = () => {}
} = {}) {
  if (!url) return { ok: false, attempts: 0, error: "Cour des comptes URL missing" };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onAttempt(attempt, maxAttempts);
    try {
      const value = await checkOnce({ url, headers, timeoutMs, requestImpl });
      return { ok: true, value, attempts: attempt };
    } catch (error) {
      const shouldRetry = attempt < maxAttempts && isTemporaryCourDesComptesError(error);
      if (!shouldRetry) return { ok: false, attempts: attempt, error };
      onRetry(error, attempt, maxAttempts);
      await delay(retryDelayMs);
    }
  }

  return { ok: false, attempts: maxAttempts, error: makeError("Cour des comptes check exhausted", "ERR_UNKNOWN") };
}
