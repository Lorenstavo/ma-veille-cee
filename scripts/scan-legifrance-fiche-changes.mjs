#!/usr/bin/env node
// Referme la boucle demandée le 2026-08-24 : "pour toute autre fiche, quand il y a un
// changement, que ça soit répercuté directement sur notre catalogue des fiches" — sans
// attendre qu'un humain repère l'arrêté à la main (ce qui avait été fait manuellement pour
// BAR-TH-174/175 le jour même).
//
// Ce script scanne Légifrance (via scripts/sources/legifrance-fiche-scan.mjs) pour tout
// arrêté récent modifiant une fiche déjà présente dans meta.ficheDetails, et ajoute l'item
// de registre correspondant dans meta.items. C'est cet ajout qui déclenche ensuite,
// automatiquement, la mise à jour du guide par update-fiche-details.mjs (staleness check :
// un item plus récent que detail.lastReviewed pour le même code déclenche une ré-extraction) —
// les deux scripts s'enchaînent dans regulatory-watch.yml, celui-ci en premier.
//
// Idempotent par construction : un texte déjà présent dans le registre (même sourceUrl)
// n'est jamais ajouté deux fois, donc relancer ce script plusieurs fois par jour (ou le
// lendemain) ne produit pas de doublons.
//
// Sans ANTHROPIC_API_KEY, ce script ne fait rien (même politique que update-fiche-details.mjs :
// pas de contenu inventé pour combler l'absence de clé).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEmbeddedData } from "./update-fiche-details.mjs";
import { findRecentFicheChanges } from "./sources/legifrance-fiche-scan.mjs";
import { findInformalSeriesNumber } from "./sources/arrete-series-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const LOOKBACK_DAYS = 14;
const DRY_RUN = process.env.DRY_RUN === "true";

function log(message) {
  console.log(`[legifrance-scan] ${message}`);
}

function slugify(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "texte";
}

function formatFrenchDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const monthIndex = Number(m) - 1;
  if (!y || !d || monthIndex < 0 || monthIndex > 11) return iso;
  const day = Number(d);
  return `${day === 1 ? "1er" : day} ${months[monthIndex]} ${y}`;
}

// Le titre suit la convention "Arrêté du <date> — <résumé bref>" (voir les items existants) :
// on ne slugifie que la partie après le tiret pour éviter un id du type
// "arrete-2026-08-17-arrete-du-17-aout-2026-..." qui répéterait la date deux fois.
function slugFromTitle(title, ficheCodes) {
  const afterDash = title && title.split(/\s+[—-]\s+/).slice(1).join(" ");
  return slugify(afterDash || title || ficheCodes.join("-"));
}

export function buildRegistryItem(change) {
  const date = change.signatureDate;
  const id = `arrete-${date}-${slugFromTitle(change.title, change.ficheCodes)}`;
  const effective = change.effectiveDate ? formatFrenchDate(change.effectiveDate) : null;
  const statusLabel = effective ? `Publié au JO — entrée en vigueur le ${effective}` : "Publié au JO";
  return {
    id,
    date,
    category: "Arrêté",
    statusLabel,
    impactLevel: change.impactLevel,
    ficheCodes: change.ficheCodes,
    title: change.title,
    summary: change.summary,
    impactText: change.impactText,
    actorImpacts: {
      delegataireMandataire: change.actorImpacts.delegataireMandataire,
      bureauControle: change.actorImpacts.bureauControle,
      professionnel: change.actorImpacts.professionnel
    },
    sourceName: "Légifrance (JORF)",
    sourceUrl: change.sourceUrl,
    official: true
  };
}

// Insère newItems en tête de "items": [ ... ], sans re-sérialiser le reste du fichier
// (même discipline que replaceFicheDetail dans update-fiche-details.mjs : préserve le
// formatage des entrées existantes pour garder des diffs git lisibles).
export function insertRegistryItems(rawJson, newItems) {
  if (!newItems.length) return rawJson;
  const token = `"items": [`;
  const start = rawJson.indexOf(token);
  if (start === -1) throw new Error(`"items": [ introuvable`);
  const insertAt = start + token.length;

  const block = newItems
    .map(item => JSON.stringify(item, null, 2).split("\n").map(line => `    ${line}`).join("\n"))
    .join(",\n");

  return `${rawJson.slice(0, insertAt)}\n${block},${rawJson.slice(insertAt)}`;
}

// Alimente la Chronologie normative (meta.arreteSeries) : demande "on peut quand même
// l'alimenter automatiquement à chaque nouvelle parution, avec les sources que tu m'as dites"
// (2026-08-24) — recherche du numéro informel via scripts/sources/arrete-series-scan.mjs pour
// chaque texte déjà confirmé sur Légifrance, et fusion sans écraser une entrée déjà confirmée.
//
// L'ordre de stockage n'a pas besoin d'être trié : le rendu client (buildChrono) re-trie
// systématiquement par num décroissant à l'affichage.
export function mergeArreteSeriesEntries(series, newEntries) {
  const byNum = new Map(series.map(entry => [entry.num, entry]));
  let maxKnown = series.length ? Math.max(...series.map(entry => entry.num)) : 0;
  const notes = [];

  for (const entry of newEntries.slice().sort((a, b) => a.num - b.num)) {
    const existing = byNum.get(entry.num);
    if (existing && existing.confirmed) {
      notes.push(`num ${entry.num} déjà confirmé au registre — nouvelle correspondance ignorée pour éviter d'écraser une entrée existante`);
      continue;
    }
    if (entry.num > maxKnown) {
      for (let n = maxKnown + 1; n < entry.num; n++) {
        if (!byNum.has(n)) byNum.set(n, { num: n, confirmed: false });
      }
      maxKnown = entry.num;
    }
    byNum.set(entry.num, entry);
  }

  const changed = newEntries.some(entry => {
    const existing = series.find(e => e.num === entry.num);
    return !existing || !existing.confirmed;
  }) || byNum.size !== series.length;

  return { series: [...byNum.values()].sort((a, b) => a.num - b.num), notes, changed };
}

function serializeArreteSeriesEntry(entry) {
  if (!entry.confirmed) return `{ "num": ${entry.num}, "confirmed": false }`;
  return `{ "num": ${entry.num}, "date": ${JSON.stringify(entry.date)}, "title": ${JSON.stringify(entry.title)}, "sourceUrl": ${JSON.stringify(entry.sourceUrl)}, "confirmed": true }`;
}

// Remplace tout le tableau "arreteSeries": [ ... ], en conservant le style compact
// (un objet par ligne) déjà utilisé pour ce tableau dans index.html.
export function replaceArreteSeries(rawJson, newSeries) {
  const token = `"arreteSeries": [`;
  const start = rawJson.indexOf(token);
  if (start === -1) throw new Error(`"arreteSeries": [ introuvable`);
  const bracketStart = start + token.length - 1;
  let depth = 0, end = -1;
  for (let i = bracketStart; i < rawJson.length; i++) {
    if (rawJson[i] === "[") depth++;
    else if (rawJson[i] === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`Tableau arreteSeries non fermé`);
  const serialized = `[\n${newSeries.map(entry => `      ${serializeArreteSeriesEntry(entry)}`).join(",\n")}\n    ]`;
  return rawJson.slice(0, bracketStart) + serialized + rawJson.slice(end);
}

async function main() {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const originalHtml = await readFile(INDEX_PATH, "utf8");
  const { data, rawJson } = parseEmbeddedData(originalHtml);
  const ficheDetails = data.meta.ficheDetails || {};
  const ficheCodes = Object.keys(ficheDetails);
  log(`Fiches surveillées : ${ficheCodes.length} (${ficheCodes.join(", ")})`);

  if (!hasApiKey) {
    log("ANTHROPIC_API_KEY absent — aucun scan ce run.");
    return;
  }
  if (!ficheCodes.length) {
    log("Aucune fiche documentée dans le catalogue — rien à surveiller.");
    return;
  }

  const sinceDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  log(`Recherche des arrêtés publiés depuis le ${sinceDate}...`);

  const changes = await findRecentFicheChanges({ ficheCodes, sinceDate });
  if (!changes.length) {
    log("Aucun changement trouvé ce run.");
    return;
  }

  const existingSourceUrls = new Set((data.items || []).map(item => item.sourceUrl).filter(Boolean));
  const seenThisRun = new Set();
  const newItems = [];
  const acceptedChanges = [];
  for (const change of changes) {
    if (existingSourceUrls.has(change.sourceUrl) || seenThisRun.has(change.sourceUrl)) {
      log(`Déjà au registre, ignoré : ${change.sourceUrl}`);
      continue;
    }
    seenThisRun.add(change.sourceUrl);
    newItems.push(buildRegistryItem(change));
    acceptedChanges.push(change);
  }

  if (!newItems.length) {
    log("Tous les changements trouvés sont déjà au registre.");
    return;
  }

  let updatedRawJson = insertRegistryItems(rawJson, newItems);

  // Chronologie normative (meta.arreteSeries) : pour chaque texte nouvellement confirmé,
  // tente de résoudre son numéro dans la série informelle suivie par la presse spécialisée.
  // Best-effort : un échec ici n'empêche jamais la publication des items de registre déjà prêts.
  const seriesEntries = [];
  for (const change of acceptedChanges) {
    let found;
    try {
      found = await findInformalSeriesNumber({ jorfUrl: change.sourceUrl, title: change.title, signatureDate: change.signatureDate });
    } catch (err) {
      log(`Numéro de série non résolu pour ${change.sourceUrl} (${err.message}) — laissé non numéroté.`);
      continue;
    }
    if (!found) { log(`Aucun numéro de série trouvé pour ${change.sourceUrl} — laissé non numéroté (comme les entrées "confirmed": false existantes).`); continue; }
    seriesEntries.push({ num: found.num, date: change.signatureDate, title: change.title, sourceUrl: change.sourceUrl, confirmed: true });
    log(`Chronologie normative : ${change.sourceUrl} identifié comme le ${found.num}e arrêté (source : ${found.pressSourceUrl}).`);
  }

  if (seriesEntries.length) {
    const { series: mergedSeries, notes, changed } = mergeArreteSeriesEntries(data.meta.arreteSeries || [], seriesEntries);
    notes.forEach(note => log(`Chronologie normative : ${note}`));
    if (changed) updatedRawJson = replaceArreteSeries(updatedRawJson, mergedSeries);
  }

  const updatedHtml = originalHtml.replace(rawJson, updatedRawJson);

  // Sécurité : le JSON produit doit rester valide et n'avoir fait disparaître ni fiche ni item existant.
  const reparsed = parseEmbeddedData(updatedHtml);
  const expectedItemCount = (data.items || []).length + newItems.length;
  if (reparsed.data.items.length !== expectedItemCount) {
    throw new Error(`Écart inattendu sur le nombre d'items (${reparsed.data.items.length} au lieu de ${expectedItemCount}) ; abandon sans écriture`);
  }
  const reparsedCodes = Object.keys(reparsed.data.meta.ficheDetails || {});
  if (reparsedCodes.length !== ficheCodes.length || ficheCodes.some(c => !reparsedCodes.includes(c))) {
    throw new Error("La mise à jour aurait fait disparaître une fiche existante ; abandon sans écriture");
  }
  const previousSeriesCount = (data.meta.arreteSeries || []).length;
  if (reparsed.data.meta.arreteSeries.length < previousSeriesCount) {
    throw new Error("La mise à jour aurait fait disparaître une entrée de la chronologie normative ; abandon sans écriture");
  }

  for (const item of newItems) log(`Nouvel item de registre : ${item.id} (${item.ficheCodes.join(", ")})`);

  if (DRY_RUN) { log(`DRY_RUN : ${newItems.length} item(s) de registre et ${seriesEntries.length} entrée(s) de chronologie auraient été ajoutés, aucun fichier modifié.`); return; }
  await writeFile(INDEX_PATH, updatedHtml, "utf8");
  log(`${newItems.length} item(s) de registre ajouté(s) dans index.html.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error(`[legifrance-scan] ERREUR: ${err.message}`);
    process.exit(1);
  });
}
