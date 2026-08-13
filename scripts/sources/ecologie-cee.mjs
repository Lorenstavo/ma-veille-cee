import { createHash } from "node:crypto";

export const EXTRACTOR_ID = "ecologie-cee-publications";
export const SOURCE_NAME = "Lettres d’information & Flash Info CEE — ecologie.gouv.fr";
export const SOURCE_URL = "https://www.ecologie.gouv.fr/politiques-publiques/comites-pilotage-lettres-dinformation-statistiques-du-dispositif-certificats";

const CEE_DOCUMENT = /(?:flash[\s_-]*info|lettre\s+d['’]?(?:information|infos?))\b[\s\S]{0,80}\bcee\b|\bstatistiques?\b[\s\S]{0,80}\bcee\b/i;
const FRENCH_MONTHS = new Map([
  ["janvier", 1], ["février", 2], ["fevrier", 2], ["mars", 3], ["avril", 4], ["mai", 5], ["juin", 6],
  ["juillet", 7], ["août", 8], ["aout", 8], ["septembre", 9], ["octobre", 10], ["novembre", 11], ["décembre", 12], ["decembre", 12]
]);

function decodeEntities(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_match, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)));
}

function textFromHtml(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
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

export function normalizePublicationUrl(value, baseUrl = SOURCE_URL) {
  const url = new URL(value, baseUrl);
  if (!validHttpUrl(url.href)) throw new Error("Publication URL is not HTTP(S)");
  url.hash = "";
  return url.href;
}

function isOfficialDocumentUrl(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "ecologie.gouv.fr" || hostname.endsWith(".ecologie.gouv.fr");
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function publishedDateFromText(value) {
  const compact = /\b(20\d{2})[-_.\/](\d{2})[-_.\/](\d{2})\b|\b(20\d{2})(\d{2})(\d{2})\b/.exec(value);
  if (compact) return isoDate(Number(compact[1] || compact[4]), Number(compact[2] || compact[5]), Number(compact[3] || compact[6]));
  const french = /\b(\d{1,2})(?:er)?\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(20\d{2})\b/i.exec(value);
  return french ? isoDate(Number(french[3]), FRENCH_MONTHS.get(french[2].toLowerCase()), Number(french[1])) : null;
}

function rawTypeFromTitle(title) {
  if (/flash[\s_-]*info/i.test(title)) return "flash-info";
  if (/lettre\s+d['’]?(?:information|infos?)/i.test(title)) return "lettre-information";
  return "statistiques-cee";
}

function externalIdFor(url) {
  return `${EXTRACTOR_ID}:${createHash("sha256").update(url).digest("hex")}`;
}

export function extractEcologieCeePublications(html, { detectedAt = new Date().toISOString() } = {}) {
  if (typeof html !== "string" || !html.trim()) throw new Error("Ecologie CEE extractor received an empty HTML response");
  const anchors = html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
  const byId = new Map();
  for (const anchor of anchors) {
    const href = attrValue(anchor[1], "href");
    const title = textFromHtml(anchor[2]);
    if (!href || !title || !CEE_DOCUMENT.test(title)) continue;
    let url;
    try { url = normalizePublicationUrl(href); } catch { continue; }
    if (!isOfficialDocumentUrl(url)) continue;
    const externalId = externalIdFor(url);
    if (byId.has(externalId)) continue;
    byId.set(externalId, {
      externalId,
      title,
      url,
      publishedAt: publishedDateFromText(title),
      sourceOfficial: true,
      rawType: rawTypeFromTitle(title),
      detectedAt
    });
  }
  const items = [...byId.values()];
  if (!items.length) throw new Error("Ecologie CEE extractor found no eligible Flash Info, Lettre d’information or statistiques CEE publication");
  return { sourceName: SOURCE_NAME, sourceUrl: SOURCE_URL, items };
}

function baselineRecord(item, previous, seenAt) {
  return {
    externalId: item.externalId,
    url: item.url,
    title: item.title,
    publishedAt: item.publishedAt,
    firstSeenAt: previous?.firstSeenAt || seenAt,
    lastSeenAt: seenAt
  };
}

export function reconcileEcologieCeePublications({ extracted, previousItems = {}, pendingItems = [], registryUrls = new Set(), seenAt = new Date().toISOString() }) {
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
      if (old.title !== item.title || old.publishedAt !== item.publishedAt || old.url !== item.url) modified.push({ externalId: item.externalId, titleChanged: old.title !== item.title, dateChanged: old.publishedAt !== item.publishedAt, urlChanged: old.url !== item.url });
    } else {
      newlyExtracted++;
      if (!initialBaseline && !pendingById.has(item.externalId) && !pendingByUrl.has(item.url) && !knownRegistryUrls.has(item.url)) {
        addedPending.push({ externalId: item.externalId, sourceName: extracted.sourceName, sourceUrl: extracted.sourceUrl, title: item.title, url: item.url, publishedAt: item.publishedAt, rawType: item.rawType, detectedAt: item.detectedAt, status: "pending" });
        pendingById.add(item.externalId);
        pendingByUrl.add(item.url);
      }
    }
    baselineItems[item.externalId] = baselineRecord(item, old, seenAt);
  }
  return { initialBaseline, baselineItems, known, newlyExtracted, modified, addedPending };
}
