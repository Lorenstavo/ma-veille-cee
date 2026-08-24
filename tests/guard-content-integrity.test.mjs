import assert from "node:assert/strict";
import test from "node:test";
import { evaluateIntegrity, extractDataJson } from "../scripts/guard-content-integrity.mjs";

function page(items) {
  return `<html><body><pre id="data-json">${JSON.stringify({ meta: {}, items })}</pre></body></html>`;
}

test("extractDataJson reads a well-formed data-json block", () => {
  const result = extractDataJson(page([{ id: "a" }, { id: "b" }]));
  assert.equal(result.error, undefined);
  assert.equal(result.data.items.length, 2);
});

test("extractDataJson reports a missing data-json block", () => {
  const result = extractDataJson("FILE_CONTENT_PLACEHOLDER");
  assert.match(result.error, /introuvable/);
});

test("extractDataJson reports malformed JSON inside the block", () => {
  const result = extractDataJson('<pre id="data-json">{not json</pre>');
  assert.match(result.error, /JSON invalide/);
});

test("a placeholder wipe is caught even with no comparable base", () => {
  const { problems } = evaluateIntegrity("index.html", "FILE_CONTENT_PLACEHOLDER", null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /introuvable/);
});

test("a like-for-like update (same size ballpark, same item count) passes", () => {
  const base = page(Array.from({ length: 35 }, (_, i) => ({ id: `item-${i}`, note: "x".repeat(1000) })));
  const current = page(Array.from({ length: 35 }, (_, i) => ({ id: `item-${i}`, note: "x".repeat(1010) })));
  const { problems } = evaluateIntegrity("index.html", current, base);
  assert.deepEqual(problems, []);
});

test("a catastrophic size collapse is flagged even if the JSON itself is well-formed", () => {
  const base = page(Array.from({ length: 35 }, (_, i) => ({ id: `item-${i}`, note: "x".repeat(2000) })));
  const current = page(Array.from({ length: 35 }, (_, i) => ({ id: `item-${i}` })));
  const { problems } = evaluateIntegrity("index.html", current, base);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /taille anormalement réduite/);
});

test("a sharp drop in item count is flagged", () => {
  const base = page(Array.from({ length: 35 }, (_, i) => ({ id: `item-${i}`, note: "x".repeat(500) })));
  const current = page(Array.from({ length: 5 }, (_, i) => ({ id: `item-${i}`, note: "x".repeat(500) })));
  const { problems } = evaluateIntegrity("index.html", current, base);
  assert.ok(problems.some(p => /nombre d'items anormalement réduit/.test(p)));
});

test("a small, deliberate item removal (e.g. deduplication) does not trip the guard", () => {
  const base = page(Array.from({ length: 35 }, (_, i) => ({ id: `item-${i}`, note: "x".repeat(1000) })));
  const current = page(Array.from({ length: 32 }, (_, i) => ({ id: `item-${i}`, note: "x".repeat(1000) })));
  const { problems } = evaluateIntegrity("index.html", current, base);
  assert.deepEqual(problems, []);
});

test("no comparable base (new file / unreadable ref) skips the ratio checks but not the shape check", () => {
  const current = page([{ id: "a" }]);
  const { problems, info } = evaluateIntegrity("index.html", current, null);
  assert.deepEqual(problems, []);
  assert.equal(info.comparable, false);
});
