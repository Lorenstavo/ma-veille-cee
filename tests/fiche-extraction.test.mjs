import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { extractFicheDetail, FICHE_DETAIL_SCHEMA } from "../scripts/sources/fiche-extraction.mjs";

const pdf = Buffer.from("%PDF-1.4 fake");

test("schema has additionalProperties:false and every property nullable at the top level", () => {
  assert.equal(FICHE_DETAIL_SCHEMA.additionalProperties, false);
  for (const [key, prop] of Object.entries(FICHE_DETAIL_SCHEMA.properties)) {
    assert.ok(FICHE_DETAIL_SCHEMA.required.includes(key), `${key} should be in required (nullable, not optional)`);
    assert.ok(Array.isArray(prop.type) && prop.type.includes("null"), `${key} should allow null`);
  }
});

test("returns parsed data on success", async () => {
  const fakeClient = {
    messages: {
      parse: async () => ({
        stop_reason: "end_turn",
        parsed_output: { version: "v.1", scope: "test" },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  const result = await extractFicheDetail({ code: "TEST", pdfBuffer: pdf, client: fakeClient });
  assert.deepEqual(result.data, { version: "v.1", scope: "test" });
});

test("returns null on a safety refusal instead of throwing", async () => {
  const fakeClient = {
    messages: { parse: async () => ({ stop_reason: "refusal", stop_details: { category: "cyber" } }) },
  };
  const result = await extractFicheDetail({ code: "TEST", pdfBuffer: pdf, client: fakeClient });
  assert.equal(result, null);
});

test("returns null when there is no parsed output", async () => {
  const fakeClient = {
    messages: { parse: async () => ({ stop_reason: "max_tokens", parsed_output: null }) },
  };
  const result = await extractFicheDetail({ code: "TEST", pdfBuffer: pdf, client: fakeClient });
  assert.equal(result, null);
});

test("returns null (not a thrown error) on an API error, so the caller can keep the old data", async () => {
  const fakeClient = {
    messages: {
      parse: async () => {
        throw new Anthropic.APIError(500, { error: { message: "boom" } }, "boom", {});
      },
    },
  };
  const result = await extractFicheDetail({ code: "TEST", pdfBuffer: pdf, client: fakeClient });
  assert.equal(result, null);
});

test("rejects an empty PDF buffer before calling the API", async () => {
  await assert.rejects(
    () => extractFicheDetail({ code: "TEST", pdfBuffer: Buffer.alloc(0), client: {} }),
    /pdfBuffer/
  );
});
