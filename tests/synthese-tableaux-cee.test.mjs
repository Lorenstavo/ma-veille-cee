import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { annotateApplicability, extractSyntheseTableaux, ficheCodesFromFilename, normalizeDocumentUrl, reconcileSyntheseTableaux, recencySignal } from "../scripts/sources/synthese-tableaux-cee.mjs";

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

test("recencySignal ranks an explicit effective date above an explicit fiche version, above 'NOUVEAU MODELE', above a bare vf suffix, above nothing", () => {
  assert.equal(recencySignal("Tableau_X_à compter du 01-09-2026.xlsx").tier, 3);
  assert.equal(recencySignal("Tableau_X_à compter de v78-4.xlsx").tier, 2);
  assert.equal(recencySignal("Tableau_X_NOUVEAU MODELE.xlsx").tier, 1);
  assert.equal(recencySignal("Tableau_X_vf4.xls").tier, 0);
  assert.equal(recencySignal("Tableau_X.xls").tier, -1);
});

test("recencySignal parses the date and version values so they order correctly within their own tier", () => {
  assert.equal(recencySignal("Tableau_X_à compter du 01-09-2026.xlsx").value, "2026-09-01");
  assert.equal(recencySignal("Tableau_X_à compter du 01-01-2022.xlsx").value, "2022-01-01");
  assert.ok(recencySignal("Tableau_X_v78-4.xlsx").value > recencySignal("Tableau_X_v62-2.xlsx").value);
  assert.ok(recencySignal("Tableau_X_vf4.xls").value > recencySignal("Tableau_X_vf.xls").value);
});

test("annotateApplicability marks the sole document of a group as applicable-unique", () => {
  const items = [{ ficheCodes: ["BAR-TH-113"], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_BAR-TH-113_TOP_vf.xls") }];
  const result = annotateApplicability(items);
  assert.equal(result[0].applicability, "applicable-unique");
});

test("annotateApplicability picks the document with the highest recency signal in a group and marks the rest superseded", () => {
  const older = { ficheCodes: ["BAR-TH-113"], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_BAR-TH-113_TOP_vf.xls") };
  const newer = { ficheCodes: ["BAR-TH-113"], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_BAR-TH-113_TOP_vf4.xls") };
  const result = annotateApplicability([older, newer]);
  const byRecency = Object.fromEntries(result.map(item => [item.recency.value, item.applicability]));
  assert.equal(byRecency[recencySignal("Tableau_BAR-TH-113_TOP_vf4.xls").value], "applicable");
  assert.equal(byRecency[recencySignal("Tableau_BAR-TH-113_TOP_vf.xls").value], "superseded");
});

test("annotateApplicability never picks a winner when two documents in a group have no usable signal", () => {
  const a = { ficheCodes: ["BAR-TH-113"], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_BAR-TH-113_TOP_0.xls") };
  const b = { ficheCodes: ["BAR-TH-113"], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_BAR-TH-113_TOP_1.xls") };
  const result = annotateApplicability([a, b]);
  assert.ok(result.every(item => item.applicability === "ambiguous"));
});

test("annotateApplicability keeps TOP and TPM documents for the same fiche in separate groups", () => {
  const top = { ficheCodes: ["BAR-TH-171", "BAR-TH-172"], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_BAR-TH-171_172_TOP_vf.xls") };
  const tpm = { ficheCodes: ["BAR-TH-171", "BAR-TH-172"], category: "Tableau de synthèse des contrôles", partyType: "TPM", recency: recencySignal("Tableau_BAR-TH-171_172_TPM_vf.xls") };
  const result = annotateApplicability([top, tpm]);
  assert.ok(result.every(item => item.applicability === "applicable-unique"), "TOP and TPM must not be compared against each other");
});

test("ficheCodesFromFilename also recognises space-separated segments (some filenames on this page use spaces instead of hyphens)", () => {
  assert.deepEqual(ficheCodesFromFilename("Tableau_BAR EN 101_BAR EN 103_TOP_VF4.xls"), ["BAR-EN-101", "BAR-EN-103"]);
});

test("annotateApplicability never treats two documents with no recognised fiche code as versions of each other, even sharing category and party type", () => {
  const unrelatedA = { externalId: "a", url: "https://x/Tableau_CDP_TOP_VF.xls", ficheCodes: [], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_CDP_TOP_VF.xls") };
  const unrelatedB = { externalId: "b", url: "https://x/Tableau_AUTRE_TOP_VF4.xls", ficheCodes: [], category: "Tableau de synthèse des contrôles", partyType: "TOP", recency: recencySignal("Tableau_AUTRE_TOP_VF4.xls") };
  const result = annotateApplicability([unrelatedA, unrelatedB]);
  assert.ok(result.every(item => item.applicability === "applicable-unique"), "two unrelated documents with no fiche code must never be compared against each other");
});
