import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { canonicalEexUrl, extractEexEmmyDocuments, reconcileEexEmmyDocuments } from "../scripts/sources/eex-emmy-documents.mjs";

const page = await readFile(new URL("./fixtures/eex-emmy-documents/page.html", import.meta.url), "utf8");
const detectedAt = "2026-08-13T08:00:00.000Z";

test("extracts only eligible official EEX EMMY operational documents", () => {
  const extracted = extractEexEmmyDocuments(page, { detectedAt });
  assert.equal(extracted.items.length, 3);
  assert.ok(extracted.items.every(item => item.sourceOfficial));
  assert.ok(extracted.items.every(item => item.url.startsWith("https://www.eex.com/fileadmin/EEX/Downloads/Registry_Services/Energy_Savings_Certificates_Documentation/")));
  assert.deepEqual(extracted.items.map(item => item.rawType), ["guide-utilisateur", "conditions-generales", "formulaire"]);
  assert.equal(extracted.items[0].publishedAt, "2025-11-12");
});

test("deduplicates links and rejects invalid or non-official document URLs", () => {
  const extracted = extractEexEmmyDocuments(page, { detectedAt });
  assert.equal(new Set(extracted.items.map(item => item.externalId)).size, extracted.items.length);
  assert.throws(() => canonicalEexUrl("javascript:alert(1)"));
  assert.throws(() => canonicalEexUrl("https://example.test/document.pdf"));
});

test("uses the official EEX table title and structured publication date", () => {
  const table = `<table><tr>
    <td data-field="publishing_date" data-date="2025-12-11">2025-12-11</td>
    <td data-field="title">White Certificates user guide (Guide utilisateur â€“ plateforme EMMY)</td>
    <td data-field="file"><a href="/fileadmin/EEX/Downloads/Registry_Services/Energy_Savings_Certificates_Documentation/20251112_White_Certificates_User_Guide.pdf">pdf (6 MB)</a></td>
  </tr></table>`;
  const [item] = extractEexEmmyDocuments(table, { detectedAt }).items;
  assert.equal(item.title, "White Certificates user guide (Guide utilisateur â€“ plateforme EMMY)");
  assert.equal(item.publishedAt, "2025-12-11");
});

test("fails safely for inaccessible or incomplete source content instead of scraping generic EEX navigation", () => {
  assert.throws(() => extractEexEmmyDocuments("<a href='/fr/markets/energy-certificates'>Energy Certificates</a>"));
  assert.throws(() => extractEexEmmyDocuments(""));
});

test("first baseline creates no pending documentation", () => {
  const extracted = extractEexEmmyDocuments(page, { detectedAt });
  const result = reconcileEexEmmyDocuments({ extracted, seenAt: detectedAt });
  assert.equal(result.initialBaseline, true);
  assert.equal(Object.keys(result.baselineItems).length, 3);
  assert.equal(result.addedPending.length, 0);
});

test("known documents do not create pending or changes", () => {
  const extracted = extractEexEmmyDocuments(page, { detectedAt });
  const first = reconcileEexEmmyDocuments({ extracted, seenAt: detectedAt });
  const next = reconcileEexEmmyDocuments({ extracted, previousItems: first.baselineItems, seenAt: "2026-08-14T08:00:00.000Z" });
  assert.equal(next.known, 3);
  assert.equal(next.newlyExtracted, 0);
  assert.equal(next.modified.length, 0);
  assert.equal(next.addedPending.length, 0);
});

test("a later guide or CGU is queued only as technical documentation", () => {
  const extracted = extractEexEmmyDocuments(page, { detectedAt });
  const first = reconcileEexEmmyDocuments({ extracted: { ...extracted, items: extracted.items.slice(0, 1) }, seenAt: detectedAt });
  const next = reconcileEexEmmyDocuments({ extracted, previousItems: first.baselineItems, seenAt: "2026-08-14T08:00:00.000Z" });
  assert.equal(next.addedPending.length, 2);
  assert.ok(next.addedPending.every(item => item.rawType === "conditions-generales" || item.rawType === "formulaire"));
  assert.ok(next.addedPending.every(item => item.status === "pending"));
});
