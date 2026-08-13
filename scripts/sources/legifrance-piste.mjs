const OAUTH_URL = "https://oauth.piste.gouv.fr/api/oauth/token";
const API_BASE_URL = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";
const PING_URL = `${API_BASE_URL}/list/ping`;
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
  return makeError("invalid-response", `${stage} HTTP ${response.status}`);
}

function safeFailure(error) {
  const code = error?.code || "invalid-response";
  const message = error instanceof Error ? error.message : "Unknown PISTE failure";
  return { ok: false, code, message };
}

export async function checkLegifrancePisteConnectivity({ clientId, clientSecret, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!clientId || !clientSecret) return { ok: false, code: "credentials-missing", message: "Légifrance PISTE credentials missing" };
  try {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "openid" });
    const tokenResponse = await fetchWithTimeout(OAUTH_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }, fetchImpl, timeoutMs);
    if (!tokenResponse.ok) throw classifyHttp("oauth", tokenResponse);
    let tokenData;
    try { tokenData = await tokenResponse.json(); } catch { throw makeError("invalid-response", "OAuth response is not valid JSON"); }
    if (!tokenData || typeof tokenData.access_token !== "string" || !tokenData.access_token || !Number.isFinite(Number(tokenData.expires_in))) throw makeError("invalid-response", "OAuth response does not contain a usable token");
    const pingResponse = await fetchWithTimeout(PING_URL, { method: "GET", headers: { authorization: `Bearer ${tokenData.access_token}`, accept: "application/json" } }, fetchImpl, timeoutMs);
    if (!pingResponse.ok) throw classifyHttp("api", pingResponse);
    return { ok: true, message: "Official PISTE API reachable", endpoint: PING_URL, expiresIn: Number(tokenData.expires_in) };
  } catch (error) {
    return safeFailure(error);
  }
}

export const LEGIFRANCE_PISTE_ENDPOINT = PING_URL;
