import https from "node:https";

export const ECOLOGIE_CONNECT_TIMEOUT_MS = 20_000;
export const ECOLOGIE_REQUEST_TIMEOUT_MS = 30_000;
export const ECOLOGIE_MAX_ATTEMPTS = 2;
export const ECOLOGIE_RETRY_DELAY_MS = 2_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export function createEcologieGouvFrAgent() {
  return new https.Agent({ keepAlive: true, maxSockets: 1, family: 4, rejectUnauthorized: true });
}

const sharedAgent = createEcologieGouvFrAgent();

function makeError(message, code, cause) {
  const error = new Error(message);
  if (code) error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function isTemporaryEcologieNetworkError(error) {
  return /^(UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ERR_SOCKET_CONNECTION_TIMEOUT)$/i.test(error?.code || "");
}

function normaliseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value ?? null]));
}

export function resolveEcologieHttpsRedirect(location, baseUrl) {
  let nextUrl;
  try { nextUrl = new URL(location, baseUrl); } catch { throw makeError("Invalid ecologie.gouv.fr redirect", "ERR_INVALID_REDIRECT"); }
  if (nextUrl.protocol !== "https:") throw makeError("Ecologie redirect is not HTTPS", "ERR_INVALID_PROTOCOL");
  return nextUrl.toString();
}

async function requestViaHttps({ url, headers, agent, connectTimeoutMs, requestTimeoutMs, redirects = 0 }) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw makeError("Ecologie redirect is not HTTPS", "ERR_INVALID_PROTOCOL");

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      handler(value);
    };
    const request = https.request(parsedUrl, {
      method: "GET",
      headers,
      agent,
      family: 4,
      rejectUnauthorized: true
    }, response => {
      const statusCode = response.statusCode || 0;
      const responseHeaders = normaliseHeaders(response.headers);
      const location = responseHeaders.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          settle(reject, makeError("Too many ecologie.gouv.fr redirects", "ERR_TOO_MANY_REDIRECTS"));
          return;
        }
        let nextUrl;
        try { nextUrl = resolveEcologieHttpsRedirect(location, parsedUrl); } catch (error) { settle(reject, error); return; }
        requestViaHttps({ url: nextUrl, headers, agent, connectTimeoutMs, requestTimeoutMs, redirects: redirects + 1 }).then(value => settle(resolve, value), error => settle(reject, error));
        return;
      }

      const contentLength = Number(responseHeaders["content-length"] || 0);
      if (contentLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        settle(reject, makeError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`, "ERR_RESPONSE_TOO_LARGE"));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on("data", chunk => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) response.destroy(makeError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`, "ERR_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("error", error => settle(reject, error));
      response.on("end", () => settle(resolve, { statusCode, headers: responseHeaders, body: Buffer.concat(chunks), url: parsedUrl.toString() }));
    });

    const requestTimer = setTimeout(() => request.destroy(makeError(`Request timeout after ${requestTimeoutMs}ms`, "ETIMEDOUT")), requestTimeoutMs);
    request.on("socket", socket => {
      // A keep-alive TLS socket may already be connected. In that case there
      // is no connection phase to time out and no socket listeners to add.
      if (socket.encrypted && socket.secureConnecting === false) return;
      const connectTimer = setTimeout(() => socket.destroy(makeError(`Connection timeout after ${connectTimeoutMs}ms`, "ETIMEDOUT")), connectTimeoutMs);
      const clearConnectTimer = () => {
        clearTimeout(connectTimer);
        socket.removeListener("secureConnect", clearConnectTimer);
        socket.removeListener("error", clearConnectTimer);
        socket.removeListener("close", clearConnectTimer);
      };
      socket.once("secureConnect", clearConnectTimer);
      socket.once("error", clearConnectTimer);
      socket.once("close", clearConnectTimer);
    });
    request.on("error", error => settle(reject, error));
    request.end();
  });
}

async function checkOnce({ url, headers, agent, connectTimeoutMs, requestTimeoutMs, requestImpl }) {
  const response = await requestImpl({ url, headers, agent, connectTimeoutMs, requestTimeoutMs, family: 4, rejectUnauthorized: true });
  if (response.statusCode < 200 || response.statusCode >= 300) throw makeError(`HTTP ${response.statusCode}`, `HTTP_${response.statusCode}`);
  if (!Buffer.isBuffer(response.body)) throw makeError("Ecologie response body is invalid", "ERR_INVALID_RESPONSE");
  return {
    finalUrl: response.url || url,
    etag: response.headers?.etag || null,
    lastModified: response.headers?.["last-modified"] || null,
    body: response.body
  };
}

export async function checkEcologieGouvFr({
  url,
  headers,
  agent = sharedAgent,
  connectTimeoutMs = ECOLOGIE_CONNECT_TIMEOUT_MS,
  requestTimeoutMs = ECOLOGIE_REQUEST_TIMEOUT_MS,
  maxAttempts = ECOLOGIE_MAX_ATTEMPTS,
  retryDelayMs = ECOLOGIE_RETRY_DELAY_MS,
  requestImpl = requestViaHttps,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onAttempt = () => {},
  onRetry = () => {}
} = {}) {
  if (!url) return { ok: false, attempts: 0, retries: 0, error: makeError("Ecologie URL missing", "ERR_INVALID_URL") };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onAttempt(attempt, maxAttempts);
    try {
      const value = await checkOnce({ url, headers, agent, connectTimeoutMs, requestTimeoutMs, requestImpl });
      return { ok: true, value, attempts: attempt, retries: attempt - 1 };
    } catch (error) {
      const shouldRetry = attempt < maxAttempts && isTemporaryEcologieNetworkError(error);
      if (!shouldRetry) return { ok: false, attempts: attempt, retries: attempt - 1, error };
      onRetry(error, attempt, maxAttempts);
      await delay(retryDelayMs);
    }
  }

  return { ok: false, attempts: maxAttempts, retries: maxAttempts - 1, error: makeError("Ecologie check exhausted", "ERR_UNKNOWN") };
}

export async function checkEcologieGouvFrSourcesSequential({ sources, ...options } = {}) {
  const responses = new Map();
  let retries = 0;
  for (const source of sources || []) {
    if (responses.has(source.url)) continue;
    const result = await checkEcologieGouvFr({ ...options, url: source.url });
    retries += result.retries || 0;
    responses.set(source.url, result);
  }
  const physicalResults = [...responses.values()];
  return {
    responses,
    summary: {
      urlsConfigured: (sources || []).length,
      networkRequestsPerformed: responses.size,
      succeeded: physicalResults.filter(result => result.ok).length,
      failed: physicalResults.filter(result => !result.ok).length,
      retries
    }
  };
}
