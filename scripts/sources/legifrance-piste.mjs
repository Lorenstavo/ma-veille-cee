const OAUTH_URL = "https://oauth.piste.gouv.fr/api/oauth/token";
const API_BASE_URL = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";

// The official FAQ documents /list/ping with the Sandbox base URL only. For
// production connectivity, use the documented JO consultation endpoint with
// the smallest valid request instead.
const LAST_N_JO_URL = `${API_BASE_URL}/consult/lastNJo`;
const LAST_N_JO_PAYLOAD = Object.freeze({ nbElement: 1 });
const DEFAULT_TIMEOUT_MS = 15_000;

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function fetchWithTimeout(url, options, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw makeError("timeout", "PISTE request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttp(stage, response) {
  if (response.status === 401) return makeError(stage === "oauth" ? "oauth-authentication-failed" : "api-unauthorized", `${stage} HTTP 401`);
  if (response.status === 403) return makeError(stage === "oauth" ? "oauth-authentication-failed" : "api-forbidden", `${stage} HTTP 403`);
  if (response.status === 429) return makeError("rate-limited", `${stage} HTTP 429${response.headers.get("retry-after") ? ` (Retry-After ${response.headers.get("retry-after")}s)` : ""}`);
  if (response.status >= 500) return makeError("server-error", `${stage} HTTP ${response.status}`);
  if (stage === "api" && response.status >= 400) return makeError("invalid-request", `${stage} HTTP ${response.status}`);
  return makeError("invalid-response", `${stage} HTTP ${response.status}`);
}

function sanitizeDiagnosticBody(value) {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/["']?(access_token|refresh_token|client_secret|authorization)["']?\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1$2[REDACTED]")
    .replace(/bearer\s+[a-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, 500) : null;
}

async function getSanitizedErrorBody(response) {
  try {
    return sanitizeDiagnosticBody(await response.text());
  } catch {
    return null;
  }
}

function safeFailure(error, diagnostics) {
  const code = error?.code || "invalid-response";
  const message = error instanceof Error ? error.message : "Unknown PISTE failure";
  return { ok: false, code, message, diagnostics };
}

export async function checkLegifrancePisteConnectivity({ clientId, clientSecret, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const diagnostics = {
    oauthTokenObtained: false,
    oauthStatus: null,
    oauthErrorBody: null,
    endpoint: LAST_N_JO_URL,
    apiStatus: null,
    apiErrorBody: null
  };
  if (!clientId || !clientSecret) return { ok: false, code: "credentials-missing", message: "Legifrance PISTE credentials missing", diagnostics };

  try {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "openid" });
    const tokenResponse = await fetchWithTimeout(OAUTH_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }, fetchImpl, timeoutMs);
    diagnostics.oauthStatus = tokenResponse.status;
    if (!tokenResponse.ok) {
      diagnostics.oauthErrorBody = await getSanitizedErrorBody(tokenResponse);
      throw classifyHttp("oauth", tokenResponse);
    }

    let tokenData;
    try { tokenData = await tokenResponse.json(); } catch { throw makeError("invalid-response", "OAuth response is not valid JSON"); }
    if (!tokenData || typeof tokenData.access_token !== "string" || !tokenData.access_token || !Number.isFinite(Number(tokenData.expires_in))) throw makeError("invalid-response", "OAuth response does not contain a usable token");
    diagnostics.oauthTokenObtained = true;

    const apiResponse = await fetchWithTimeout(LAST_N_JO_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenData.access_token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(LAST_N_JO_PAYLOAD)
    }, fetchImpl, timeoutMs);
    diagnostics.apiStatus = apiResponse.status;
    if (!apiResponse.ok) {
      diagnostics.apiErrorBody = await getSanitizedErrorBody(apiResponse);
      throw classifyHttp("api", apiResponse);
    }
    try { await apiResponse.json(); } catch { throw makeError("invalid-response", "API response is not valid JSON"); }

    return { ok: true, message: "Official PISTE API reachable via lastNJo", endpoint: LAST_N_JO_URL, payload: LAST_N_JO_PAYLOAD, expiresIn: Number(tokenData.expires_in), diagnostics };
  } catch (error) {
    return safeFailure(error, diagnostics);
  }
}

export const LEGIFRANCE_PISTE_ENDPOINT = LAST_N_JO_URL;
export const LEGIFRANCE_PISTE_CONNECTIVITY_PAYLOAD = LAST_N_JO_PAYLOAD;
