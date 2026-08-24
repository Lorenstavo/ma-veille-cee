import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { findRecentFicheChanges, isOfficialLegifranceUrl } from "../scripts/sources/legifrance-fiche-scan.mjs";

const validChange = {
  ficheCodes: ["BAR-TH-174"],
  sourceUrl: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000054734487",
  signatureDate: "2026-08-17",
  effectiveDate: "2026-09-01",
  impactLevel: "high",
  title: "Arrêté du 17 août 2026 — test",
  summary: "résumé",
  impactText: "impact",
  actorImpacts: {
    delegataireMandataire: { level: "high", text: "a" },
    bureauControle: { level: "medium", text: "b" },
    professionnel: { level: "medium", text: "c" }
  }
};

test("isOfficialLegifranceUrl accepts only legifrance.gouv.fr", () => {
  assert.equal(isOfficialLegifranceUrl("https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000123"), true);
  assert.equal(isOfficialLegifranceUrl("https://legifrance.gouv.fr/jorf/id/JORFTEXT000123"), true);
  assert.equal(isOfficialLegifranceUrl("https://www.ecologie.gouv.fr/jorf/id/JORFTEXT000123"), false);
  assert.equal(isOfficialLegifranceUrl("not a url"), false);
});

test("returns [] without calling the API when ficheCodes is empty", async () => {
  const result = await findRecentFicheChanges({ ficheCodes: [], sinceDate: "2026-08-01", client: {} });
  assert.deepEqual(result, []);
});

test("returns parsed changes on success", async () => {
  const fakeClient = {
    messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { changes: [validChange] } }) }
  };
  const result = await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceUrl, validChange.sourceUrl);
});

test("filters out a candidate whose URL is not an official legifrance.gouv.fr page", async () => {
  const fakeClient = {
    messages: {
      parse: async () => ({
        stop_reason: "end_turn",
        parsed_output: { changes: [{ ...validChange, sourceUrl: "https://www.example.com/fake" }] }
      })
    }
  };
  const result = await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.deepEqual(result, []);
});

test("filters out a candidate with no fiche codes", async () => {
  const fakeClient = {
    messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { changes: [{ ...validChange, ficheCodes: [] }] } }) }
  };
  const result = await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.deepEqual(result, []);
});

test("filters out a candidate with a missing or malformed signatureDate", async () => {
  const fakeClient = {
    messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { changes: [{ ...validChange, signatureDate: "17 août 2026" }] } }) }
  };
  const result = await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.deepEqual(result, []);
});

test("returns [] on a safety refusal instead of throwing", async () => {
  const fakeClient = {
    messages: { parse: async () => ({ stop_reason: "refusal", stop_details: { category: "cyber" } }) }
  };
  const result = await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.deepEqual(result, []);
});

test("returns [] (not a thrown error) on an API error", async () => {
  const fakeClient = {
    messages: {
      parse: async () => { throw new Anthropic.APIError(500, { error: { message: "boom" } }, "boom", {}); }
    }
  };
  const result = await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.deepEqual(result, []);
});

test("returns [] when there is no usable structured output", async () => {
  const fakeClient = {
    messages: { parse: async () => ({ stop_reason: "max_tokens", parsed_output: null }) }
  };
  const result = await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.deepEqual(result, []);
});

test("restricts the web_search tool to the official legifrance.gouv.fr domain", async () => {
  let capturedTools;
  const fakeClient = {
    messages: {
      parse: async (params) => {
        capturedTools = params.tools;
        return { stop_reason: "end_turn", parsed_output: { changes: [] } };
      }
    }
  };
  await findRecentFicheChanges({ ficheCodes: ["BAR-TH-174"], sinceDate: "2026-08-01", client: fakeClient });
  assert.equal(capturedTools.length, 1);
  assert.deepEqual(capturedTools[0].allowed_domains, ["legifrance.gouv.fr", "www.legifrance.gouv.fr"]);
});
