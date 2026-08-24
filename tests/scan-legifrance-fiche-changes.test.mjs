import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseEmbeddedData } from "../scripts/update-fiche-details.mjs";
import { buildRegistryItem, insertRegistryItems } from "../scripts/scan-legifrance-fiche-changes.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

const change = {
  ficheCodes: ["BAR-TH-174", "BAR-TH-175"],
  sourceUrl: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000099999999",
  signatureDate: "2026-09-10",
  effectiveDate: "2027-01-01",
  impactLevel: "high",
  title: "Arrêté du 10 septembre 2026 — test unitaire",
  summary: "résumé",
  impactText: "impact",
  actorImpacts: {
    delegataireMandataire: { level: "high", text: "a" },
    bureauControle: { level: "medium", text: "b" },
    professionnel: { level: "medium", text: "c" }
  }
};

test("buildRegistryItem derives a clean id from the part of the title after the dash", () => {
  const item = buildRegistryItem(change);
  assert.equal(item.id, "arrete-2026-09-10-test-unitaire");
  assert.equal(item.date, "2026-09-10");
  assert.equal(item.category, "Arrêté");
  assert.equal(item.statusLabel, "Publié au JO — entrée en vigueur le 1er janvier 2027");
  assert.equal(item.official, true);
  assert.equal(item.sourceUrl, change.sourceUrl);
  assert.deepEqual(item.ficheCodes, ["BAR-TH-174", "BAR-TH-175"]);
});

test("buildRegistryItem falls back to a plain 'Publié au JO' label without an effective date", () => {
  const item = buildRegistryItem({ ...change, effectiveDate: null });
  assert.equal(item.statusLabel, "Publié au JO");
});

test("buildRegistryItem falls back to slugifying the whole title when there is no dash", () => {
  const item = buildRegistryItem({ ...change, title: "Titre sans tiret" });
  assert.equal(item.id, "arrete-2026-09-10-titre-sans-tiret");
});

test("insertRegistryItems prepends without touching anything already in the array", () => {
  const { rawJson } = parseEmbeddedData(html);
  const item = buildRegistryItem(change);
  const updatedRawJson = insertRegistryItems(rawJson, [item]);

  const before = rawJson.slice(0, rawJson.indexOf(`"items": [`) + `"items": [`.length);
  assert.ok(updatedRawJson.startsWith(before), "content up to and including the opening bracket must be untouched");

  // Everything that followed the opening bracket in the original file must still be present,
  // byte-for-byte, right after our inserted block.
  const originalRest = rawJson.slice(rawJson.indexOf(`"items": [`) + `"items": [`.length);
  assert.ok(updatedRawJson.endsWith(originalRest), "existing items must be preserved untouched after the insertion");
});

test("insertRegistryItems round-trips through the full HTML and adds exactly one item", () => {
  const { data, rawJson } = parseEmbeddedData(html);
  const item = buildRegistryItem(change);
  const updatedRawJson = insertRegistryItems(rawJson, [item]);
  const updatedHtml = html.replace(rawJson, updatedRawJson);
  const { data: finalData } = parseEmbeddedData(updatedHtml);

  assert.equal(finalData.items.length, data.items.length + 1);
  assert.equal(finalData.items[0].id, item.id);
  assert.deepEqual(finalData.items.slice(1), data.items);
  assert.deepEqual(finalData.meta.ficheDetails, data.meta.ficheDetails);
});

test("insertRegistryItems with an empty list returns the input untouched", () => {
  const { rawJson } = parseEmbeddedData(html);
  assert.equal(insertRegistryItems(rawJson, []), rawJson);
});

test("insertRegistryItems supports multiple items in one pass, in the given order", () => {
  const { data, rawJson } = parseEmbeddedData(html);
  const itemA = buildRegistryItem(change);
  const itemB = buildRegistryItem({ ...change, signatureDate: "2026-09-11", sourceUrl: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000088888888" });
  const updatedRawJson = insertRegistryItems(rawJson, [itemA, itemB]);
  const updatedHtml = html.replace(rawJson, updatedRawJson);
  const { data: finalData } = parseEmbeddedData(updatedHtml);

  assert.equal(finalData.items.length, data.items.length + 2);
  assert.equal(finalData.items[0].id, itemA.id);
  assert.equal(finalData.items[1].id, itemB.id);
});
