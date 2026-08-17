import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { extractEcologieCeePublications } from "../scripts/sources/ecologie-cee.mjs";
import {
  checkEcologieGouvFr,
  checkEcologieGouvFrSourcesSequential,
  createEcologieGouvFrAgent,
  ECOLOGIE_CONNECT_TIMEOUT_MS,
  ECOLOGIE_REQUEST_TIMEOUT_MS,
  ECOLOGIE_RETRY_DELAY_MS,
  resolveEcologieHttpsRedirect
} from "../scripts/sources/ecologie-gouv-fr.mjs";

const url = "https://www.ecologie.gouv.fr/politiques-publiques/dispositif-certificats-deconomies-denergie";
const archive = await readFile(new URL("./fixtures/ecologie-cee/archive.html", import.meta.url));
const okResponse = (body = Buffer.from("<html>ecologie</html>")) => ({
  statusCode: 200,
  headers: { etag: 'W/"test"', "last-modified": "Thu, 13 Aug 2026 12:00:00 GMT" },
  body,
  url
});
const temporaryError = code => Object.assign(new Error(code), { code });

test("uses a shared non-keep-alive IPv4 agent with strict TLS on first success", async () => {
  const agent = createEcologieGouvFrAgent();
  const calls = [];
  const result = await checkEcologieGouvFr({ url, agent, requestImpl: async options => { calls.push(options); return okResponse(); } });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(agent.options.keepAlive, false);
  assert.equal(agent.maxSockets, 1);
  assert.equal(calls[0].agent, agent);
  assert.equal(calls[0].family, 4);
  assert.equal(calls[0].rejectUnauthorized, true);
  assert.equal(calls[0].connectTimeoutMs, ECOLOGIE_CONNECT_TIMEOUT_MS);
  assert.equal(calls[0].requestTimeoutMs, ECOLOGIE_REQUEST_TIMEOUT_MS);
});

test("retries one timeout after two seconds then succeeds", async () => {
  let calls = 0;
  const pauses = [];
  const result = await checkEcologieGouvFr({
    url,
    requestImpl: async () => (++calls === 1 ? Promise.reject(temporaryError("ETIMEDOUT")) : okResponse()),
    delay: async ms => { pauses.push(ms); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 1);
  assert.deepEqual(pauses, [ECOLOGIE_RETRY_DELAY_MS]);
});

test("stops after two timeouts", async () => {
  let calls = 0;
  const result = await checkEcologieGouvFr({ url, requestImpl: async () => { calls += 1; throw temporaryError("ETIMEDOUT"); }, delay: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 1);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(calls, 2);
});

test("retries ECONNRESET once then succeeds", async () => {
  let calls = 0;
  const result = await checkEcologieGouvFr({ url, requestImpl: async () => (++calls === 1 ? Promise.reject(temporaryError("ECONNRESET")) : okResponse()), delay: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("does not retry HTTP 403 or a TLS verification error", async () => {
  for (const requestImpl of [
    async () => ({ ...okResponse(), statusCode: 403 }),
    async () => { throw temporaryError("UNABLE_TO_VERIFY_LEAF_SIGNATURE"); }
  ]) {
    let pauses = 0;
    const result = await checkEcologieGouvFr({ url, requestImpl, delay: async () => { pauses += 1; } });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(pauses, 0);
  }
});

test("follows HTTPS redirects only", () => {
  assert.equal(resolveEcologieHttpsRedirect("/politiques-publiques/cee", url), "https://www.ecologie.gouv.fr/politiques-publiques/cee");
  assert.throws(() => resolveEcologieHttpsRedirect("http://example.test/", url), { code: "ERR_INVALID_PROTOCOL" });
});

test("deduplicates eight logical sources into seven sequential URL checks", async () => {
  const sources = Array.from({ length: 7 }, (_value, index) => ({ name: `source-${index}`, url: `https://www.ecologie.gouv.fr/page-${index}` }));
  sources.push({ name: "PNCEE duplicate", url: sources[1].url });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const result = await checkEcologieGouvFrSourcesSequential({
    sources,
    requestImpl: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return okResponse();
    }
  });
  assert.equal(calls, 7);
  assert.equal(maxActive, 1);
  assert.deepEqual(result.summary, { urlsConfigured: 8, networkRequestsPerformed: 7, succeeded: 7, failed: 0, retries: 0 });
});

test("reuses the retrieved Flash Info body for the V2.1 extractor", async () => {
  const pilotUrl = "https://www.ecologie.gouv.fr/politiques-publiques/comites-pilotage-lettres-dinformation-statistiques-du-dispositif-certificats";
  const result = await checkEcologieGouvFrSourcesSequential({
    sources: [{ name: "Flash info", url: pilotUrl }],
    requestImpl: async () => ({ ...okResponse(archive), url: pilotUrl })
  });
  const cachedBody = result.responses.get(pilotUrl).value.body.toString("utf8");
  assert.equal(extractEcologieCeePublications(cachedBody, { detectedAt: "2026-08-13T08:00:00.000Z" }).items.length, 3);
  assert.equal(result.summary.networkRequestsPerformed, 1);
});
