import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { extractSyntheseTableaux, ficheCodesFromFilename, normalizeDocumentUrl, reconcileSyntheseTableaux } from "../scripts/sources/synthese-tableaux-cee.mjs";

const archive = await readFile(new URL("./fixtures/synthese-tableaux-cee/archive.html", import.meta.url), "utf8");
const detectedAt = "2026-09-15T08:00:00.000Z";
const seenAt = "2026-09-15T08:01:00.000Z";

test("extracts only relevant synthesis-table/inspection-group documents, ignoring unrelated PDFs", () => {
  const result = extractSyntheseTableaux(archive, { detectedAt });
  assert.equal(result.items.length, 4);
  assert.ok(result.items.every(item => item.url.startsWith("https://www.ecologie.gouv.fr/")));
  assert.ok(!result.items.some(item => item.url.includes("arrete-du-4-septembre-2014")), "the cited arrêté PDF must not be extracted");
  assert.ok(!result.items.some(item => item.url.includes("style.pdf")), "an unrelated PDF filename must not be extracted");
});

test("categorises inspection groups separately from control synthesis tables", () => {
  const result = extractSyntheseTableaux(archive, { detectedAt });
  const groupe = result.items.find(item => item.url.includes("Groupes%20de%20competences"));
  assert.equal(groupe.category, "Groupe de compétences (inspection CEE)");
  const tableau = result.items.find(item => item.url.includes("BAR-TH-113"));
  assert.equal(tableau.category, "Tableau de synthèse des contrôles");
});

test("ficheCodesFromFilename recognises a full code and a bare sibling number sharing the same prefix", () => {
  assert.deepEqual(ficheCodesFromFilename("Tableau_BAR-TH-171_172_TOP_vf.xlsx"), ["BAR-TH-171", "BAR-TH-172"]);
  assert.deepEqual(ficheCodesFromFilename("Tableau_BAR-TH-113_TOP_vf.xls"), ["BAR-TH-113"]);
  assert.deepEqual(ficheCodesFromFilename("Groupes de competences - Inspection CEE - 1 - Enveloppe.pdf"), []);
});

test("first extraction creates a baseline without pending items", () => {
  const result = reconcileSyntheseTableaux({ extracted: extractSyntheseTableaux(archive, { detectedAt }), seenAt });
  assert.equal(result.initialBaseline, true);
  assert.equal(Object.keys(result.baselineItems).length, 4);
  assert.equal(result.addedPending.length, 0);
});

test("known documents produce neither new nor pending items on the next run", () => {
  const extracted = extractSyntheseTableaux(archive, { detectedAt });
  const first = reconcileSyntheseTableaux({ extracted, seenAt });
  const next = reconcileSyntheseTableaux({ extracted, previousItems: first.baselineItems, seenAt: "2026-09-16T08:00:00.000Z" });
  assert.equal(next.known, 4);
  assert.equal(next.newlyExtracted, 0);
  assert.equal(next.addedPending.length, 0);
});

test("a newly added document (e.g. a replacement filename) is placed in pending exactly once", () => {
  const extracted = extractSyntheseTableaux(archive, { detectedAt });
  const first = reconcileSyntheseTableaux({ extracted: { ...extracted, items: extracted.items.slice(0, 3) }, seenAt });
  const next = reconcileSyntheseTableaux({ extracted, previousItems: first.baselineItems, seenAt });
  assert.equal(next.addedPending.length, 1);
  const repeat = reconcileSyntheseTableaux({ extracted, previousItems: next.baselineItems, pendingItems: next.addedPending, seenAt });
  assert.equal(repeat.addedPending.length, 0);
});

test("a title change on a known document is journalised without a new pending item", () => {
  const extracted = extractSyntheseTableaux(archive, { detectedAt });
  const first = reconcileSyntheseTableaux({ extracted, seenAt });
  const changed = structuredClone(extracted);
  changed.items[0].title = "Titre corrigé";
  const next = reconcileSyntheseTableaux({ extracted: changed, previousItems: first.baselineItems, seenAt });
  assert.equal(next.modified.length, 1);
  assert.equal(next.modified[0].titleChanged, true);
  assert.equal(next.addedPending.length, 0);
});

test("registry URLs prevent a duplicate pending document", () => {
  const extracted = extractSyntheseTableaux(archive, { detectedAt });
  const next = reconcileSyntheseTableaux({ extracted: { ...extracted, items: extracted.items.slice(0, 3) }, seenAt });
  const withNew = reconcileSyntheseTableaux({ extracted, previousItems: next.baselineItems, registryUrls: new Set([extracted.items[3].url]), seenAt });
  assert.equal(withNew.addedPending.length, 0);
});

test("rejects an invalid URL scheme and empty/unavailable input safely", () => {
  assert.throws(() => normalizeDocumentUrl("javascript:alert(1)"));
  assert.throws(() => extractSyntheseTableaux("", { detectedAt }));
  assert.throws(() => extractSyntheseTableaux("<html><body>rien ici</body></html>", { detectedAt }));
});
