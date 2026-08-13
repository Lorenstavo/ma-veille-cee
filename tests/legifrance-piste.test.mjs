import assert from "node:assert/strict";
import test from "node:test";
import { checkLegifrancePisteConnectivity, LEGIFRANCE_PISTE_ENDPOINT } from "../scripts/sources/legifrance-piste.mjs";

const credentials = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const response = (body, options = {}) => new Response(body, { status: options.status || 200, headers: options.headers });
const mock = responses => async () => responses.shift();

test("connects with OAuth then the official Légifrance ping", async () => {
  const result = await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response(JSON.stringify({ access_token: "test-token", expires_in: 3600 })), response("{}")] ) });
  assert.equal(result.ok, true);
  assert.equal(result.endpoint, LEGIFRANCE_PISTE_ENDPOINT);
  assert.equal(result.message.includes("test-token"), false);
});
test("reports missing credentials without requesting OAuth", async () => {
  let calls = 0; const result = await checkLegifrancePisteConnectivity({ fetchImpl: async () => { calls++; return response("{}"); } });
  assert.equal(result.code, "credentials-missing"); assert.equal(calls, 0);
});
test("classifies OAuth 401", async () => {
  const result = await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response("", { status: 401 })]) });
  assert.equal(result.code, "oauth-authentication-failed");
});
test("classifies API 403 and 429", async () => {
  const token = response(JSON.stringify({ access_token: "test-token", expires_in: 60 }));
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([token, response("", { status: 403 })]) })).code, "api-forbidden");
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response(JSON.stringify({ access_token: "test-token", expires_in: 60 })), response("", { status: 429, headers: { "retry-after": "5" } })]) })).code, "rate-limited");
});
test("classifies API 401 and server errors", async () => {
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response(JSON.stringify({ access_token: "test-token", expires_in: 60 })), response("", { status: 401 })]) })).code, "api-unauthorized");
  assert.equal((await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response(JSON.stringify({ access_token: "test-token", expires_in: 60 })), response("", { status: 503 })]) })).code, "server-error");
});
test("classifies timeout and invalid JSON safely", async () => {
  const timeout = await checkLegifrancePisteConnectivity({ ...credentials, timeoutMs: 1, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(timeout.code, "timeout");
  const invalid = await checkLegifrancePisteConnectivity({ ...credentials, fetchImpl: mock([response("not-json")]) });
  assert.equal(invalid.code, "invalid-response");
});
test("diagnostics never contain secret material", async () => {
  const secret = "never-log-this-secret";
  const result = await checkLegifrancePisteConnectivity({ clientId: "client", clientSecret: secret, fetchImpl: mock([response("", { status: 401 })]) });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
