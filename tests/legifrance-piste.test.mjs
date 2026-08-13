import assert from "node:assert/strict";
import test from "node:test";
import { checkLegifrancePisteConnectivity, LEGIFRANCE_PISTE_CONNECTIVITY_PAYLOAD, LEGIFRANCE_PISTE_ENDPOINT } from "../scripts/sources/legifrance-piste.mjs";

const credentials = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const response = (body, options = {}) => new Response(body, { status: options.status || 200, headers: options.headers });
const mock = responses => async (...args) => {
  const next = responses.shift();
  if (typeof next === "function") return next(...args);
  return next;
};

test("connects with OAuth then the official Legifrance lastNJo endpoint", async () => {
  const calls = [];
  const result = await checkLegifrancePisteConnectivity({
    ...credentials,
    fetchImpl: mock([
      (...args) => { calls.push(args); return response(JSON.stringify({ access_token: "test-token", expires_in: 3600 })); },
      (...args) => { calls.push(args); return response(JSON.stringify({ results: [] })); }
    ])
  });
  assert.equal(result.ok, true);
  assert.equal(result.endpoint, LEGIFRANCE_PISTE_ENDPOINT);
  assert.deepEqual(result.payload, LEGIFRANCE_PISTE_CONNECTIVITY_PAYLOAD);
  assert.equal(calls[1][0], LEGIFRANCE_PISTE_ENDPOINT);
  assert.equal(calls[1][1].method, "POST");
  assert.equal(calls[1][1].body, JSON.stringify({ nbElement: 1 }));
  assert.equal(result.message.includes("test-token"), false);
});

test("reports missing credentials without requesting OAuth", async () => {
  let calls = 0;
  const result = await checkLegifrancePisteConnectivity({ fetchImpl: async () => { calls++; return response("{}"); } });
  assert.equal(result.code, "credentials-missing");
  assert.equal(result.diagnostics.oauthTokenObtained, false);
  assert.equal(calls, 0);
});

test("classifies OAuth 401", async () => {
  const result = await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response("", { status: 401 })]) });
  assert.equal(result.code, "oauth-authentication-failed");
  assert.equal(result.diagnostics.oauthTokenObtained, false);
  assert.equal(result.diagnostics.oauthStatus, 401);
});

test("classifies API 403, 429, and invalid requests", async () => {
  const token = response(JSON.stringify({ access_token: "test-token", expires_in: 60 }));
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([token, response("", { status: 403 })]) })).code, "api-forbidden");
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response(JSON.stringify({ access_token: "test-token", expires_in: 60 })), response("", { status: 429, headers: { "retry-after": "5" } })]) })).code, "rate-limited");
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response(JSON.stringify({ access_token: "test-token", expires_in: 60 })), response("", { status: 400 })]) })).code, "invalid-request");
});

test("separates a successful OAuth exchange from an API 500", async () => {
  const result = await checkLegifrancePisteConnectivity({
    ...credentials,
    fetchImpl: mock([
      response(JSON.stringify({ access_token: "test-token", expires_in: 60 })),
      response('{"error":"temporary upstream issue","access_token":"must-not-appear"}', { status: 500 })
    ])
  });
  assert.equal(result.code, "server-error");
  assert.equal(result.message, "api HTTP 500");
  assert.equal(result.diagnostics.oauthTokenObtained, true);
  assert.equal(result.diagnostics.oauthStatus, 200);
  assert.equal(result.diagnostics.apiStatus, 500);
  assert.match(result.diagnostics.apiErrorBody, /temporary upstream issue/);
  assert.equal(result.diagnostics.apiErrorBody.includes("must-not-appear"), false);
});

test("classifies API 401 and timeout", async () => {
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response(JSON.stringify({ access_token: "test-token", expires_in: 60 })), response("", { status: 401 })]) })).code, "api-unauthorized");
  const timeout = await checkLegifrancePisteConnectivity({ ...credentials, timeoutMs: 1, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(timeout.code, "timeout");
});

test("classifies invalid JSON safely and diagnostics never contain secret material", async () => {
  const invalid = await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response("not-json")]) });
  assert.equal(invalid.code, "invalid-response");
  const secret = "never-log-this-secret";
  const result = await checkLegifrancePisteConnectivity({ clientId: "client", clientSecret: secret, fetchImpl: mock([response("", { status: 401 })]) });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
