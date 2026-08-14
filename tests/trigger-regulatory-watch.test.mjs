import assert from "node:assert/strict";
import test from "node:test";
import {
  createRegulatoryWatchHandler,
  getParisTime,
  shouldDispatchAt
} from "../netlify/functions/trigger-regulatory-watch.mjs";

const TOKEN = "test-token-that-must-not-appear-in-logs";
const summerParis0805 = new Date("2026-08-14T06:05:00.000Z");
const winterParis0805 = new Date("2026-01-14T07:05:00.000Z");
const saturdayParis0805 = new Date("2026-08-15T06:05:00.000Z");
const outsideWindow = new Date("2026-08-14T06:30:00.000Z");

function response(status, body = "") {
  return new Response(status === 204 ? null : body, { status });
}

function memoryLogger() {
  const messages = [];
  return {
    messages,
    info: message => messages.push(String(message)),
    error: message => messages.push(String(message))
  };
}

function makeHandler({ now = summerParis0805, env = {}, fetchImpl = async () => response(200), logger = memoryLogger() } = {}) {
  return {
    logger,
    handler: createRegulatoryWatchHandler({
      env: { GITHUB_TOKEN_REGULATORY_WATCH: TOKEN, ...env },
      now: () => now,
      fetchImpl,
      logger,
      timeoutMs: 20
    })
  };
}

test("recognises the summer and winter 08:05 Paris dispatch windows", () => {
  assert.deepEqual(getParisTime(summerParis0805).hour, 8);
  assert.deepEqual(getParisTime(winterParis0805).hour, 8);
  assert.equal(shouldDispatchAt(summerParis0805), true);
  assert.equal(shouldDispatchAt(winterParis0805), true);
});

test("does not dispatch on Saturday or outside the Paris time window", async () => {
  for (const now of [saturdayParis0805, outsideWindow]) {
    let calls = 0;
    const { handler } = makeHandler({ now, fetchImpl: async () => { calls += 1; return response(200); } });
    assert.equal((await handler()).status, 200);
    assert.equal(calls, 0);
  }
});

test("reports a missing token without attempting a request", async () => {
  let calls = 0;
  const { handler, logger } = makeHandler({
    env: { GITHUB_TOKEN_REGULATORY_WATCH: "" },
    fetchImpl: async () => { calls += 1; return response(200); }
  });
  assert.equal((await handler()).status, 500);
  assert.equal(calls, 0);
  assert.match(logger.messages.join("\n"), /not configured/);
});

test("normal mode sends dry_run=false and accepts GitHub HTTP 200 or 204", async () => {
  for (const status of [200, 204]) {
    let options;
    const { handler } = makeHandler({ fetchImpl: async (_url, request) => { options = request; return response(status); } });
    assert.equal((await handler()).status, 200);
    assert.equal(JSON.parse(options.body).inputs.dry_run, "false");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test("manual test bypasses the schedule and always sends dry_run=true", async () => {
  let options;
  const { handler, logger } = makeHandler({
    now: saturdayParis0805,
    env: { REGULATORY_WATCH_MANUAL_TEST: "true" },
    fetchImpl: async (_url, request) => { options = request; return response(200); }
  });
  assert.equal((await handler()).status, 200);
  assert.equal(JSON.parse(options.body).inputs.dry_run, "true");
  assert.match(logger.messages.join("\n"), /Mode: TEST/);
});

test("classifies GitHub API errors without leaking the token", async () => {
  for (const status of [401, 403, 404, 422, 500]) {
    const { handler, logger } = makeHandler({
      fetchImpl: async () => response(status, `diagnostic ${TOKEN} Bearer ${TOKEN}`)
    });
    assert.equal((await handler()).status, 502);
    const output = logger.messages.join("\n");
    assert.match(output, new RegExp(`\\(${status}\\)`));
    assert.doesNotMatch(output, new RegExp(TOKEN));
    assert.doesNotMatch(output, /Bearer test-token/);
  }
});

test("reports a timeout network failure without leaking the token", async () => {
  const { handler, logger } = makeHandler({
    fetchImpl: async () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; }
  });
  assert.equal((await handler()).status, 502);
  assert.match(logger.messages.join("\n"), /timed out/);
  assert.doesNotMatch(logger.messages.join("\n"), new RegExp(TOKEN));
});
