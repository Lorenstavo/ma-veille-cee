import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseEmbeddedData,
  pickLatestRelatedItem,
  mergeFicheDetail,
  replaceFicheDetail
} from "../scripts/update-fiche-details.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("pickLatestRelatedItem finds the newest item tagged with a fiche code", () => {
  const items = [
    { id: "a", date: "2026-01-01", ficheCodes: ["BAT-TH-116"] },
    { id: "b", date: "2026-06-15", ficheCodes: ["BAT-TH-116", "TER110"] },
    { id: "c", date: "2026-03-01", ficheCodes: ["TER120"] }
  ];
  assert.equal(pickLatestRelatedItem(items, "BAT-TH-116").id, "b");
  assert.equal(pickLatestRelatedItem(items, "TER120").id, "c");
  assert.equal(pickLatestRelatedItem(items, "UNKNOWN"), null);
});

test("mergeFicheDetail keeps old values when the extraction returns null/empty for a field", () => {
  const old = { scope: "old scope", eligibleSectors: ["A", "B"], version: "v1" };
  const extracted = { scope: null, eligibleSectors: [], version: "v2" };
  const merged = mergeFicheDetail(old, extracted);
  assert.equal(merged.scope, "old scope");
  assert.deepEqual(merged.eligibleSectors, ["A", "B"]);
  assert.equal(merged.version, "v2");
});

test("mergeFicheDetail overwrites with a genuinely new non-empty value", () => {
  const old = { requiredWorks: ["old work"] };
  const extracted = { requiredWorks: ["new work 1", "new work 2"] };
  assert.deepEqual(mergeFicheDetail(old, extracted).requiredWorks, ["new work 1", "new work 2"]);
});

test("replaceFicheDetail round-trips against the real index.html BAT-TH-116 entry without touching anything else", () => {
  const { data, rawJson } = parseEmbeddedData(html);
  assert.ok(data.meta.ficheDetails["BAT-TH-116"], "fixture assumption: BAT-TH-116 exists in index.html");

  const replacement = { version: "TEST-VERSION", scope: "test scope only", lastReviewed: "2099-01-01" };
  const updatedRawJson = replaceFicheDetail(rawJson, "BAT-TH-116", replacement);

  // Everything before the replaced object is untouched.
  const before = rawJson.slice(0, rawJson.indexOf('"BAT-TH-116": {'));
  assert.ok(updatedRawJson.startsWith(before), "content before the fiche entry must be byte-identical");

  // The result re-parses as valid JSON with exactly the replacement for that one fiche.
  const reparsed = JSON.parse(updatedRawJson);
  assert.deepEqual(reparsed.meta.ficheDetails["BAT-TH-116"], replacement);
  // Every other fiche code in ficheDetails (if any) and the rest of meta must survive untouched.
  assert.deepEqual(reparsed.meta.ficheCatalog, data.meta.ficheCatalog);

  // And splicing it into the full HTML still yields the same document structure end to end.
  const updatedHtml = html.replace(rawJson, updatedRawJson);
  const { data: finalData } = parseEmbeddedData(updatedHtml);
  assert.equal(finalData.meta.ficheDetails["BAT-TH-116"].version, "TEST-VERSION");
  assert.equal(Object.keys(finalData.meta.ficheDetails).length, Object.keys(data.meta.ficheDetails).length);
});

test("replaceFicheDetail throws clearly on an unknown code instead of corrupting the file", () => {
  const { rawJson } = parseEmbeddedData(html);
  assert.throws(() => replaceFicheDetail(rawJson, "DOES-NOT-EXIST", {}), /introuvable/);
});
