import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { findInformalSeriesNumber, isAllowedPressUrl } from "../scripts/sources/arrete-series-scan.mjs";

const args = { jorfUrl: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000054734487", title: "Arrêté du 17 août 2026 — test", signatureDate: "2026-08-17" };

test("isAllowedPressUrl accepts only the closed list of specialized press domains", () => {
  assert.equal(isAllowedPressUrl("https://www.hellio.com/actus/exemple"), true);
  assert.equal(isAllowedPressUrl("https://selectra.info/energie/actualites/exemple"), true);
  assert.equal(isAllowedPressUrl("https://particulier.hellio.com/blog/exemple"), true);
  assert.equal(isAllowedPressUrl("https://www.legifrance.gouv.fr/jorf/id/x"), false);
  assert.equal(isAllowedPressUrl("https://random-blog.example.com/cee"), false);
  assert.equal(isAllowedPressUrl("not a url"), false);
});

test("returns the number when found on an allowed press domain", async () => {
  const fakeClient = {
    messages: {
      parse: async () => ({
        stop_reason: "end_turn",
        parsed_output: { found: true, num: 87, pressSourceUrl: "https://www.hellio.com/actus/87e-arrete-cee", citation: "le 87e arrêté modifiant..." }
      })
    }
  };
  const result = await findInformalSeriesNumber({ ...args, client: fakeClient });
  assert.deepEqual(result, { num: 87, pressSourceUrl: "https://www.hellio.com/actus/87e-arrete-cee", citation: "le 87e arrêté modifiant..." });
});

test("returns null when found is false", async () => {
  const fakeClient = { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { found: false, num: null, pressSourceUrl: null, citation: null } }) } };
  const result = await findInformalSeriesNumber({ ...args, client: fakeClient });
  assert.equal(result, null);
});

test("rejects a number sourced from a non-official press domain", async () => {
  const fakeClient = {
    messages: {
      parse: async () => ({
        stop_reason: "end_turn",
        parsed_output: { found: true, num: 87, pressSourceUrl: "https://random-blog.example.com/cee", citation: "..." }
      })
    }
  };
  const result = await findInformalSeriesNumber({ ...args, client: fakeClient });
  assert.equal(result, null);
});

test("rejects a non-integer or non-positive num even if found is true", async () => {
  const fakeClient1 = { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { found: true, num: 3.5, pressSourceUrl: "https://www.hellio.com/x", citation: null } }) } };
  assert.equal(await findInformalSeriesNumber({ ...args, client: fakeClient1 }), null);
  const fakeClient2 = { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { found: true, num: 0, pressSourceUrl: "https://www.hellio.com/x", citation: null } }) } };
  assert.equal(await findInformalSeriesNumber({ ...args, client: fakeClient2 }), null);
});

test("returns null on a safety refusal instead of throwing", async () => {
  const fakeClient = { messages: { parse: async () => ({ stop_reason: "refusal" }) } };
  assert.equal(await findInformalSeriesNumber({ ...args, client: fakeClient }), null);
});

test("returns null (not a thrown error) on an API error", async () => {
  const fakeClient = { messages: { parse: async () => { throw new Anthropic.APIError(500, { error: { message: "boom" } }, "boom", {}); } } };
  assert.equal(await findInformalSeriesNumber({ ...args, client: fakeClient }), null);
});

test("restricts the web_search tool to the closed press domain list", async () => {
  let capturedTools;
  const fakeClient = {
    messages: {
      parse: async (params) => {
        capturedTools = params.tools;
        return { stop_reason: "end_turn", parsed_output: { found: false, num: null, pressSourceUrl: null, citation: null } };
      }
    }
  };
  await findInformalSeriesNumber({ ...args, client: fakeClient });
  assert.ok(capturedTools[0].allowed_domains.includes("hellio.com"));
  assert.ok(!capturedTools[0].allowed_domains.includes("legifrance.gouv.fr"));
});
