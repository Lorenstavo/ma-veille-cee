import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCourDesComptes,
  COUR_DES_COMPTES_MAX_ATTEMPTS,
  COUR_DES_COMPTES_RETRY_DELAY_MS,
  COUR_DES_COMPTES_TIMEOUT_MS
} from "../scripts/sources/cour-des-comptes.mjs";

const url = "https://www.ccomptes.fr/fr/publications/les-certificats-deconomies-denergie-0";
const okResponse = () => ({
  statusCode: 200,
  headers: { etag: 'W/"test"', "last-modified": "Thu, 13 Aug 2026 12:00:00 GMT" },
  body: Buffer.from("<html>Cour des comptes</html>"),
  url
});
const temporaryError = code => Object.assign(new Error(code), { code });

test("succeeds on the first attempt with strict TLS and IPv4", async () => {
  const calls = [];
  const result = await checkCourDesComptes({
    url,
    requestImpl: async options => { calls.push(options); return okResponse(); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls[0].family, 4);
  assert.equal(calls[0].rejectUnauthorized, true);
  assert.equal(calls[0].timeoutMs, COUR_DES_COMPTES_TIMEOUT_MS);
});

test("retries a timeout once then succeeds", async () => {
  const attempts = [];
  const retries = [];
  const delays = [];
  let calls = 0;
  const result = await checkCourDesComptes({
    url,
    requestImpl: async () => (++calls === 1 ? Promise.reject(temporaryError("ETIMEDOUT")) : okResponse()),
    delay: async ms => { delays.push(ms); },
    onAttempt: attempt => attempts.push(attempt),
    onRetry: error => retries.push(error.code)
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(retries, ["ETIMEDOUT"]);
  assert.deepEqual(delays, [COUR_DES_COMPTES_RETRY_DELAY_MS]);
});

test("stops after two temporary timeouts", async () => {
  let calls = 0;
  const result = await checkCourDesComptes({
    url,
    requestImpl: async () => { calls += 1; throw temporaryError("ETIMEDOUT"); },
    delay: async () => {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, COUR_DES_COMPTES_MAX_ATTEMPTS);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(calls, 2);
});

test("retries ECONNRESET once then succeeds", async () => {
  let calls = 0;
  const result = await checkCourDesComptes({
    url,
    requestImpl: async () => (++calls === 1 ? Promise.reject(temporaryError("ECONNRESET")) : okResponse()),
    delay: async () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("does not retry HTTP 403 or a valid HTTP 500 response", async () => {
  for (const statusCode of [403, 500]) {
    let calls = 0;
    const result = await checkCourDesComptes({
      url,
      requestImpl: async () => { calls += 1; return { ...okResponse(), statusCode }; },
      delay: async () => { throw new Error("No retry should occur"); }
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.error.code, `HTTP_${statusCode}`);
    assert.equal(calls, 1);
  }
});
