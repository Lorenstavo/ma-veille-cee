// Extraction des "tableaux de synthèse des contrôles" (modèles Excel/PDF à utiliser par les
// organismes d'inspection CEE) et des documents "Groupes de compétences — Inspection CEE",
// tous deux publiés sur la page Questions-réponses CEE d'ecologie.gouv.fr. Demande du
// 2026-09-15 : lister ces documents sur le site et alerter à chaque ajout/changement.
//
// Suit exactement le même schéma extract()/reconcile() que scripts/sources/ecologie-cee.mjs
// (voir ce fichier pour le principe général). Particularité de cette page : une mise à jour
// de contenu s'y traduit presque toujours par un nouveau fichier à une nouvelle URL (suffixes
// "_vf4", "_0", "NOUVEAU MODELE"...), l'ancien restant souvent en place — un simple diff sur
// l'ensemble des URLs de documents suffit donc à détecter à la fois les ajouts et les
// remplacements, sans avoir besoin d'un contrôle de contenu (HEAD/hash) par fichier, qui
// multiplierait par ~140 les requêtes vers un domaine déjà connu pour limiter les accès
// répétés (voir scripts/sources/ecologie-gouv-fr.mjs).

import { createHash } from "node:crypto";

export const EXTRACTOR_ID = "synthese-tableaux-cee";
export const SOURCE_NAME = "Questions-réponses CEE — ecologie.gouv.fr";
export const SOURCE_URL = "https://www.ecologie.gouv.fr/politiques-publiques/questions-reponses-dispositif-cee";

const DOCUMENT_EXTENSIONS = /\.(xlsx?|docx?|pdf)$/i;
// Les documents pertinents commencent systématiquement par l'un de ces intitulés sur cette
// page — filtre volontairement strict pour ne pas remonter les autres pièces jointes du Q&A
// (arrêtés cités en référence, etc., déjà couverts par d'autres sources).
const RELEVANT_FILENAME = /^(Tableau|Groupes de comp[ée]tences)/i;
// Bornes en lookaround plutôt que \b : ces noms de fichier séparent systématiquement les
// codes par "_" (ex. "Tableau_BAR-TH-113_TOP_vf.xls"), qui est un caractère de mot au sens
// regex — \b ne verrait donc aucune frontière entre "_" et "B", ni entre "113" et "_TOP".
const FICHE_CODE = /(?<![A-Za-z0-9])([A-Z]{2,4})-([A-Z]{2})-(\d{2,4})(-SE)?(?![A-Za-z0-9])/g;

function decodeEntities(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_match, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)));
}

function attrValue(attributes, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeDocumentUrl(value, baseUrl = SOURCE_URL) {
  const url = new URL(value, baseUrl);
  if (!validHttpUrl(url.href)) throw new Error("Document URL is not HTTP(S)");
  url.hash = "";
  return url.href;
}

function isOfficialDocumentUrl(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "ecologie.gouv.fr" || hostname.endsWith(".ecologie.gouv.fr");
}

function filenameOf(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
}

function labelFromFilename(filename) {
  return filename.replace(DOCUMENT_EXTENSIONS, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

// Repère les codes de fiche complets (ex. BAR-TH-171), puis rattache les numéros isolés qui
// suivent immédiatement avec le même préfixe implicite (ex. "BAR-TH-171_172" → aussi
// BAR-TH-172) — convention de nommage fréquente sur cette page pour deux fiches jumelles.
// Heuristique, pas une garantie : sert à un affichage informatif, pas à une donnée critique.
export function ficheCodesFromFilename(filename) {
  const codes = new Set();
  let lastPrefix = null;
  let cursor = 0;
  for (const match of filename.matchAll(FICHE_CODE)) {
    codes.add(`${match[1]}-${match[2]}-${match[3]}${match[4] || ""}`);
    lastPrefix = `${match[1]}-${match[2]}`;
    cursor = match.index + match[0].length;
  }
  if (lastPrefix) {
    const bareNumbers = filename.slice(cursor).matchAll(/^[_-](\d{2,4})(?![A-Za-z0-9])/g);
    for (const bare of bareNumbers) codes.add(`${lastPrefix}-${bare[1]}`);
  }
  return [...codes];
}

function categoryFor(filename) {
  if (/^Groupes de comp[ée]tences/i.test(filename)) return "Groupe de compétences (inspection CEE)";
  return "Tableau de synthèse des contrôles";
}

function externalIdFor(url) {
  return `${EXTRACTOR_ID}:${createHash("sha256").update(url).digest("hex")}`;
}

export function extractSyntheseTableaux(html, { detectedAt = new Date().toISOString() } = {}) {
  if (typeof html !== "string" || !html.trim()) throw new Error("Synthèse tableaux extractor received an empty HTML response");
  const anchors = html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
  const byId = new Map();
  for (const anchor of anchors) {
    const href = attrValue(anchor[1], "href");
    if (!href || !DOCUMENT_EXTENSIONS.test(href)) continue;
    let url;
    try { url = normalizeDocumentUrl(href); } catch { continue; }
    if (!isOfficialDocumentUrl(url)) continue;
    const filename = filenameOf(url);
    if (!RELEVANT_FILENAME.test(filename)) continue;
    const externalId = externalIdFor(url);
    if (byId.has(externalId)) continue;
    byId.set(externalId, {
      externalId,
      title: labelFromFilename(filename),
      url,
      ficheCodes: ficheCodesFromFilename(filename),
      category: categoryFor(filename),
      detectedAt
    });
  }
  const items = [...byId.values()];
  if (!items.length) throw new Error("Synthèse tableaux extractor found no eligible document");
  return { sourceName: SOURCE_NAME, sourceUrl: SOURCE_URL, items };
}

function baselineRecord(item, previous, seenAt) {
  return {
    externalId: item.externalId,
    url: item.url,
    title: item.title,
    ficheCodes: item.ficheCodes,
    category: item.category,
    firstSeenAt: previous?.firstSeenAt || seenAt,
    lastSeenAt: seenAt
  };
}

export function reconcileSyntheseTableaux({ extracted, previousItems = {}, pendingItems = [], registryUrls = new Set(), seenAt = new Date().toISOString() }) {
  const previous = previousItems && typeof previousItems === "object" ? previousItems : {};
  const initialBaseline = Object.keys(previous).length === 0;
  const baselineItems = { ...previous };
  const pendingById = new Set(pendingItems.map(item => item?.externalId).filter(Boolean));
  const pendingByUrl = new Set(pendingItems.map(item => item?.url).filter(Boolean));
  const knownRegistryUrls = new Set([...registryUrls].filter(Boolean));
  const addedPending = [], modified = [];
  let known = 0, newlyExtracted = 0;

  for (const item of extracted.items) {
    const old = previous[item.externalId];
    if (old) {
      known++;
      if (old.title !== item.title || old.category !== item.category) modified.push({ externalId: item.externalId, titleChanged: old.title !== item.title, categoryChanged: old.category !== item.category });
    } else {
      newlyExtracted++;
      if (!initialBaseline && !pendingById.has(item.externalId) && !pendingByUrl.has(item.url) && !knownRegistryUrls.has(item.url)) {
        addedPending.push({ externalId: item.externalId, sourceName: extracted.sourceName, sourceUrl: extracted.sourceUrl, title: item.title, url: item.url, ficheCodes: item.ficheCodes, category: item.category, detectedAt: item.detectedAt, status: "pending" });
        pendingById.add(item.externalId);
        pendingByUrl.add(item.url);
      }
    }
    baselineItems[item.externalId] = baselineRecord(item, old, seenAt);
  }
  return { initialBaseline, baselineItems, known, newlyExtracted, modified, addedPending };
}
