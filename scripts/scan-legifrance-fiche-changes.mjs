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
  for (const change of changes) {
    if (existingSourceUrls.has(change.sourceUrl) || seenThisRun.has(change.sourceUrl)) {
      log(`Déjà au registre, ignoré : ${change.sourceUrl}`);
      continue;
    }
    seenThisRun.add(change.sourceUrl);
    newItems.push(buildRegistryItem(change));
  }

  if (!newItems.length) {
    log("Tous les changements trouvés sont déjà au registre.");
    return;
  }

  const updatedRawJson = insertRegistryItems(rawJson, newItems);
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

  for (const item of newItems) log(`Nouvel item de registre : ${item.id} (${item.ficheCodes.join(", ")})`);

  if (DRY_RUN) { log(`DRY_RUN : ${newItems.length} item(s) auraient été ajoutés, aucun fichier modifié.`); return; }
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
