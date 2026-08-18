import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/watch-health.js", import.meta.url), "utf8");
const context = vm.createContext({ globalThis: {} });
vm.runInContext(source, context);
const { classifyWatch } = context.globalThis.RegulatoryWatchHealth;

const names = [
  "Légifrance (JO, textes CEE)", "PNCEE — modalités de dépôt des dossiers CEE", "Dispositif CEE — ecologie.gouv.fr", "Opérations standardisées — ecologie.gouv.fr", "Consultations publiques — developpement-durable.gouv.fr", "Questions-réponses CEE — ecologie.gouv.fr",
  "Lettres d'information & Flash Info CEE — ecologie.gouv.fr", "Conseil supérieur de l'énergie (CSE)", "Registre national EMMY", "Liste des PAC agréées (bonus-pac.ademe.fr)",
  "Cour des comptes — publications CEE", "ATEE — Club C2E", "Programmes CEE d'accompagnement — ecologie.gouv.fr", "Énergies — ecologie.gouv.fr"
];
const watch = (failed = []) => ({ sources: names.map(name => ({ name, status: failed.includes(name) ? "failed" : "success" })) });

test("six critical sources available never produce a critical health state", () => {
  const health = classifyWatch(watch(["Registre national EMMY"]));
  assert.equal(health.groups.critical.available, 6);
  assert.equal(health.groups.critical.total, 6);
  assert.equal(health.status, "degraded");
});

test("one unavailable critical source produces a critical health state", () => {
  const health = classifyWatch(watch(["PNCEE — modalités de dépôt des dossiers CEE"]));
  assert.equal(health.groups.critical.available, 5);
  assert.equal(health.status, "critical");
});

test("EMMY, Cour des comptes, or both unavailable produce degraded mode", () => {
  for (const failed of [["Registre national EMMY"], ["Cour des comptes — publications CEE"], ["Registre national EMMY", "Cour des comptes — publications CEE"]]) {
    assert.equal(classifyWatch(watch(failed)).status, "degraded");
  }
});

test("all historical sources available produce operational mode with dynamic counters", () => {
  const health = classifyWatch(watch());
  assert.equal(health.status, "operational");
  assert.deepEqual(Object.values(health.groups).map(group => [group.available, group.total]), [[6, 6], [4, 4], [4, 4]]);
});

test("an EEX supplementary success never compensates for an unavailable EMMY registry", () => {
  const health = classifyWatch({ ...watch(["Registre national EMMY"]), supplementaryChannels: [{ id: "eex-emmy-documents", status: "success" }] });
  assert.equal(health.groups.important.available, 3);
  assert.equal(health.status, "degraded");
});
