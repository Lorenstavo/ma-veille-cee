import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  EXTRACTOR_ID,
  SOURCE_URL,
  extractCourDesComptesRss,
  fetchCourDesComptesRss,
  matchCeeReasons,
  reconcileCourDesComptesRss,
  rssText
} from "../scripts/sources/cour-des-comptes-rss.mjs";

const feed = await readFile(new URL("./fixtures/cour-des-comptes-rss/feed.xml", import.meta.url), "utf8");
const emptyFeed = await readFile(new URL("./fixtures/cour-des-comptes-rss/empty.xml", import.meta.url), "utf8");
const detectedAt = "2026-08-13T08:00:00.000Z";
const response = (body, options = {}) => ({ statusCode: options.statusCode || 200, headers: { "content-type": options.contentType || "application/rss+xml; charset=utf-8" }, body: Buffer.from(body), url: SOURCE_URL });

test("accepts valid RSS and extracts only safe text fields", () => {
  const extracted = extractCourDesComptesRss(feed, { detectedAt });
  assert.equal(extracted.items.length, 2);
  assert.equal(extracted.items[0].description.includes("<p>"), false);
  assert.deepEqual(extracted.items[0].matchReasons, ["certificats d'économies d'énergie", "efficacité énergétique", "CEE"]);
  assert.equal(extracted.items[0].publishedAt, "2026-08-12");
});

test("reports a technically valid empty RSS without treating it as invalid", () => {
  const extracted = extractCourDesComptesRss(emptyFeed, { detectedAt });
  assert.equal(extracted.empty, true);
  assert.equal(extracted.items.length, 0);
});

test("rejects invalid XML and fetch timeout", async () => {
  assert.throws(() => extractCourDesComptesRss("<html>not RSS</html>"), { code: "ERR_RSS_INVALID_XML" });
  await assert.rejects(fetchCourDesComptesRss({ requestImpl: async () => { const error = new Error("timeout"); error.code = "ETIMEDOUT"; throw error; } }), { code: "ETIMEDOUT" });
});

test("uses a stable GUID first and falls back to canonical URL", () => {
  const withGuid = extractCourDesComptesRss(`<?xml version="1.0"?><rss><channel><item><title>CEE</title><link>https://example.test/a#fragment</link><guid>stable-guid-42</guid></item></channel></rss>`).items[0];
  const withoutGuid = extractCourDesComptesRss(`<?xml version="1.0"?><rss><channel><item><title>CEE</title><link>https://example.test/a#fragment</link></item></channel></rss>`).items[0];
  assert.match(withGuid.externalId, new RegExp(`^${EXTRACTOR_ID}:`));
  assert.notEqual(withGuid.externalId, withoutGuid.externalId);
  assert.equal(withoutGuid.url, "https://example.test/a");
});

test("matches CEE only as an autonomous word and detects energy efficiency", () => {
  assert.deepEqual(matchCeeReasons({ title: "Les CEE", description: "" }), ["CEE"]);
  assert.deepEqual(matchCeeReasons({ title: "Dispositif CEE", description: "" }), ["CEE"]);
  assert.deepEqual(matchCeeReasons({ title: "CEEnergie", description: "" }), []);
  assert.deepEqual(matchCeeReasons({ title: "Rapport", description: "L'efficacité énergétique est analysée." }), ["efficacité énergétique"]);
  assert.equal(rssText("&lt;p&gt;Texte &amp; détail&lt;/p&gt;").includes("<"), false);
});

test("creates a full baseline on first run without pending items", () => {
  const extracted = extractCourDesComptesRss(feed, { detectedAt });
  const result = reconcileCourDesComptesRss({ extracted, seenAt: detectedAt });
  assert.equal(result.initialBaseline, true);
  assert.equal(Object.keys(result.baselineItems).length, 2);
  assert.equal(result.addedPending.length, 0);
});

test("produces neither pending nor duplicate on a known feed", () => {
  const extracted = extractCourDesComptesRss(feed, { detectedAt });
  const first = reconcileCourDesComptesRss({ extracted, seenAt: detectedAt });
  const next = reconcileCourDesComptesRss({ extracted, previousItems: first.baselineItems, seenAt: "2026-08-14T08:00:00.000Z" });
  assert.equal(next.initialBaseline, false);
  assert.equal(next.newlyExtracted, 0);
  assert.equal(next.addedPending.length, 0);
});

test("queues a later CEE match but only baselines a non-pertinent item", () => {
  const extracted = extractCourDesComptesRss(feed, { detectedAt });
  const first = reconcileCourDesComptesRss({ extracted: { ...extracted, items: extracted.items.slice(1) }, seenAt: detectedAt });
  const pending = reconcileCourDesComptesRss({ extracted, previousItems: first.baselineItems, seenAt: "2026-08-14T08:00:00.000Z" });
  assert.equal(pending.addedPending.length, 1);
  assert.deepEqual(pending.addedPending[0].matchReasons, ["certificats d'économies d'énergie", "efficacité énergétique", "CEE"]);
  const nonRelevant = reconcileCourDesComptesRss({ extracted: { ...extracted, items: extracted.items.slice(1) }, previousItems: {}, seenAt: detectedAt });
  assert.equal(nonRelevant.addedPending.length, 0);
});

test("reads RSS HTTP 200 XML without executing any remote content", async () => {
  const result = await fetchCourDesComptesRss({ requestImpl: async () => response(feed) });
  assert.equal(result.statusCode, 200);
  assert.equal(result.bodyText.includes("<script"), false);
});

test("follows an HTTPS RSS redirect", async () => {
  const calls = [];
  const result = await fetchCourDesComptesRss({
    requestImpl: async options => {
      calls.push(options.url);
      return calls.length === 1
        ? { statusCode: 301, headers: { location: "https://www.ccomptes.fr/rss/publications/" }, body: Buffer.alloc(0), url: options.url }
        : response(feed);
    }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
});
