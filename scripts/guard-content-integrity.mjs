#!/usr/bin/env node
// Garde-fou anti-écrasement : détecte si un commit qui vient d'atterrir sur main a corrompu
// ou vidé index.html / cae-espagne/index.html (ex. incident du 2026-08-19 où tout le fichier
// avait été remplacé par le littéral "FILE_CONTENT_PLACEHOLDER"), quelle que soit la source du
// commit (workflow connu ou non). Compare l'état courant (working tree, déjà checkout à HEAD)
// à un commit de référence antérieur (BASE_REF) réputé sain, sur deux axes indépendants :
//
//   1. Le bloc `<pre id="data-json">` doit exister et parser comme du JSON valide avec la
//      forme attendue ({ meta, items: [...] }).
//   2. La taille du fichier et le nombre d'items ne doivent pas s'effondrer par rapport à
//      BASE_REF (le registre est en pratique toujours croissant — voir le seuil ci-dessous).
//
// N'écrit rien : se contente de sortir en échec (exit 1) avec un message clair si un problème
// est détecté. C'est au workflow appelant de décider quoi faire (restaurer le contenu de
// BASE_REF, voir .github/workflows/content-guard.yml).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GUARDED_FILES = ["index.html", "cae-espagne/index.html"];

// Un registre de veille ne perd normalement jamais d'entrées : on tolère une petite marge
// (suppression manuelle ponctuelle d'un doublon, correction éditoriale) mais pas un
// effondrement brutal, qui trahit un écrasement accidentel plutôt qu'une édition volontaire.
const MIN_SIZE_RATIO = 0.5; // le fichier ne doit pas perdre plus de 50% de sa taille
const MIN_ITEMS_RATIO = 0.8; // ni plus de 20% de ses items
const MIN_ABSOLUTE_BYTES = 20_000; // aucun des deux fichiers n'est jamais descendu sous ~190 Ko en usage réel
const MIN_ABSOLUTE_ITEMS = 5;

function log(message) {
  console.log(`[content-guard] ${message}`);
}

export function extractDataJson(text) {
  const match = text.match(/<pre id="data-json">([\s\S]*?)<\/pre>/);
  if (!match) return { error: 'bloc <pre id="data-json"> introuvable' };
  try {
    const data = JSON.parse(match[1]);
    if (!data || typeof data !== "object" || !Array.isArray(data.items)) {
      return { error: "JSON valide mais forme inattendue (pas de tableau items)" };
    }
    return { data };
  } catch (err) {
    return { error: `JSON invalide dans le bloc data-json (${err.message})` };
  }
}

function readAtRef(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  } catch (err) {
    return null; // fichier absent à cette référence (ex. première apparition) — pas comparable
  }
}

// Coeur pur de la vérification (aucun accès disque/git) : facile à tester unitairement avec
// des chaînes synthétiques. Retourne { problems, info } où info porte les métriques calculées
// pour le seul cas "tout va bien" (utilisé pour le message de log).
export function evaluateIntegrity(label, currentText, baseText) {
  const problems = [];

  const current = extractDataJson(currentText);
  if (current.error) {
    problems.push(`${label}: ${current.error}`);
    return { problems, info: null };
  }

  if (baseText === null) {
    return { problems, info: { comparable: false } };
  }
  const base = extractDataJson(baseText);
  if (base.error) {
    return { problems, info: { comparable: false, baseError: base.error } };
  }

  const currentBytes = Buffer.byteLength(currentText, "utf8");
  const baseBytes = Buffer.byteLength(baseText, "utf8");
  const minBytes = Math.max(MIN_ABSOLUTE_BYTES, baseBytes * MIN_SIZE_RATIO);
  if (currentBytes < minBytes) {
    problems.push(
      `${label}: taille anormalement réduite (${currentBytes} octets vs ${baseBytes} à la référence, seuil ${Math.round(minBytes)})`
    );
  }

  const currentItems = current.data.items.length;
  const baseItems = base.data.items.length;
  const minItems = Math.max(MIN_ABSOLUTE_ITEMS, baseItems * MIN_ITEMS_RATIO);
  if (currentItems < minItems) {
    problems.push(
      `${label}: nombre d'items anormalement réduit (${currentItems} vs ${baseItems} à la référence, seuil ${Math.round(minItems)})`
    );
  }

  return { problems, info: { comparable: true, currentBytes, baseBytes, currentItems, baseItems } };
}

function checkFile(file, baseRef) {
  const currentText = readFileSync(file, "utf8");
  const baseText = readAtRef(baseRef, file);
  const { problems, info } = evaluateIntegrity(file, currentText, baseText);

  if (!problems.length) {
    if (!info || !info.comparable) {
      log(`${file}: pas de référence comparable à ${baseRef} — vérification de forme uniquement (OK).`);
    } else {
      log(`${file}: OK (${info.currentBytes} octets, ${info.currentItems} items ; référence ${baseRef}: ${info.baseBytes} octets, ${info.baseItems} items).`);
    }
  }
  return problems;
}

function main() {
  const baseRef = process.env.BASE_REF || "HEAD~1";
  log(`Référence de comparaison : ${baseRef}`);

  const allProblems = GUARDED_FILES.flatMap(file => checkFile(file, baseRef));

  if (allProblems.length) {
    log("ÉCHEC — intégrité du contenu compromise :");
    for (const problem of allProblems) log(`  - ${problem}`);
    process.exit(1);
  }

  log("Tous les fichiers surveillés passent le contrôle d'intégrité.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
