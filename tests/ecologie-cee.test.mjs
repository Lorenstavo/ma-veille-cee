import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { extractEcologieCeePublications, normalizePublicationUrl, publishedDateFromText, reconcileEcologieCeePublications } from "../scripts/sources/ecologie-cee.mjs";

const archive = await readFile(new URL("./fixtures/ecologie-cee/archive.html", import.meta.url), "utf8");
const incomplete = await readFile(new URL("./fixtures/ecologie-cee/incomplete.html", import.meta.url), "utf8");
const detectedAt = "2026-08-13T08:00:00.000Z";
const seenAt = "2026-08-13T08:01:00.000Z";

test("extracts only eligible official CEE archive documents", () => {
  const result = extractEcologieCeePublications(archive, { detectedAt });
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map(item => item.rawType), ["flash-info", "lettre-information", "statistiques-cee"]);
  assert.equal(result.items[0].publishedAt, "2026-08-13");
  assert.equal(result.items[1].publishedAt, "2026-08-14");
  assert.equal(result.items[2].publishedAt, "2026-08-15");
  assert.ok(result.items.every(item => item.url.startsWith("https://www.ecologie.gouv.fr/")));
});

test("first extraction creates a baseline without pending items", () => {
  const result = reconcileEcologieCeePublications({ extracted: extractEcologieCeePublications(archive, { detectedAt }), seenAt });
  assert.equal(result.initialBaseline, true);
  assert.equal(Object.keys(result.baselineItems).length, 3);
  assert.equal(result.addedPending.length, 0);
});

test("known publications produce neither new nor pending items", () => {
  const extracted = extractEcologieCeePublications(archive, { detectedAt });
  const first = reconcileEcologieCeePublications({ extracted, seenAt });
  const next = reconcileEcologieCeePublications({ extracted, previousItems: first.baselineItems, seenAt: "2026-08-14T08:00:00.000Z" });
  assert.equal(next.initialBaseline, false);
  assert.equal(next.known, 3);
  assert.equal(next.newlyExtracted, 0);
  assert.equal(next.addedPending.length, 0);
});

test("one or two new publications are placed in pending once", () => {
  const extracted = extractEcologieCeePublications(archive, { detectedAt });
  const first = reconcileEcologieCeePublications({ extracted: { ...extracted, items: extracted.items.slice(0, 1) }, seenAt });
  const next = reconcileEcologieCeePublications({ extracted, previousItems: first.baselineItems, seenAt });
  assert.equal(next.addedPending.length, 2);
  const repeat = reconcileEcologieCeePublications({ extracted, previousItems: next.baselineItems, pendingItems: next.addedPending, seenAt });
  assert.equal(repeat.addedPending.length, 0);
});

test("title and date changes are journalised without a pending item", () => {
  const extracted = extractEcologieCeePublications(archive, { detectedAt });
  const first = reconcileEcologieCeePublications({ extracted, seenAt });
  const changed = structuredClone(extracted);
  changed.items[0].title = "Télécharger 2026-08-14 Flash Info CEE — titre corrigé PDF";
  changed.items[0].publishedAt = "2026-08-14";
  const next = reconcileEcologieCeePublications({ extracted: changed, previousItems: first.baselineItems, seenAt });
  assert.equal(next.modified.length, 1);
  assert.equal(next.modified[0].titleChanged, true);
  assert.equal(next.modified[0].dateChanged, true);
  assert.equal(next.addedPending.length, 0);
});

test("registry URLs prevent a duplicate pending publication", () => {
  const extracted = extractEcologieCeePublications(archive, { detectedAt });
  const previousItems = { "known:seed": { externalId: "known:seed", url: "https://www.ecologie.gouv.fr/sites/default/files/documents/known.pdf", title: "Publication connue", publishedAt: null, firstSeenAt: seenAt, lastSeenAt: seenAt } };
  const next = reconcileEcologieCeePublications({ extracted, previousItems, registryUrls: new Set([extracted.items[0].url]), seenAt });
  assert.equal(next.addedPending.length, 2);
});

test("absent dates stay null and invalid, incomplete or unavailable input is rejected safely", () => {
  assert.equal(publishedDateFromText("Flash Info CEE sans date"), null);
  assert.throws(() => normalizePublicationUrl("javascript:alert(1)"));
  assert.throws(() => extractEcologieCeePublications(incomplete, { detectedAt }));
  assert.throws(() => extractEcologieCeePublications("", { detectedAt }));
});
