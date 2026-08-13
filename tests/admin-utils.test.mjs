import assert from "node:assert/strict";
import test from "node:test";
import { mergePendingReviews, normalizePendingItems } from "../admin/admin-utils.mjs";

const source = { externalId: "ecologie-cee:abc", title: "Flash Info CEE", url: "https://www.ecologie.gouv.fr/sites/default/files/flash.pdf", status: "pending" };

test("accepts an empty pending queue", () => {
  assert.deepEqual(normalizePendingItems([]), []);
});

test("filters malformed and duplicate pending data", () => {
  const rows = normalizePendingItems([source, { ...source }, { externalId: "invalid", title: "Sans URL", url: "javascript:alert(1)" }]);
  assert.equal(rows.length, 1);
});

test("merges ignored and analysis-ready reviews without altering pending", () => {
  const pending = normalizePendingItems([source]);
  const ignored = mergePendingReviews(pending, [{ external_id: source.externalId, status: "ignored", notes: "Hors périmètre" }]);
  assert.equal(ignored[0].reviewStatus, "ignored");
  assert.equal(pending[0].status, "pending");
  const ready = mergePendingReviews(pending, [{ external_id: source.externalId, status: "analysis-ready", notes: "À analyser" }]);
  assert.equal(ready[0].reviewStatus, "analysis-ready");
});
