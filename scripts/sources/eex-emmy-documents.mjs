import { createHash } from "node:crypto";

export const EXTRACTOR_ID = "eex-emmy-documents";
export const SOURCE_NAME = "EEX — documentation EMMY";
export const SOURCE_URL = "https://www.eex.com/fr/markets/energy-certificates/certificats-deconomies-denergie";

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_match, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)));
}

function textFromHtml(value) {
  return decodeEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attrValue(attributes, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

export function canonicalEexUrl(value, baseUrl = SOURCE_URL) {
  const url = new URL(value, baseUrl);
  if (url.protocol !== "https:" || (url.hostname !== "www.eex.com" && url.hostname !== "eex.com")) throw new Error("EEX documentation URL is not an official HTTPS URL");
  url.hash = "";
  return url.href;
}

function eligibleDocument(title, url) {
  const descriptor = normaliseDescriptor(`${title} ${url}`);
  const isEexDocumentation = /\/fileadmin\/eex\/downloads\/registry_services\/energy_savings_certificates_documentation\//i.test(url);
  if (!isEexDocumentation) return false;
  if (/declaration\s+sur\s+l'?honneur/.test(descriptor)) return true;
  return /\bemmy\b|white certificates|certificats? d['’]economies? d['’]energie|energy savings certificates|guide utilisateur|user guide|conditions? generales?|general conditions|formulaire|declaration sur l['’]honneur|signatures?/i.test(descriptor);
}

function rawType(title, url) {
  const descriptor = normaliseDescriptor(`${title} ${url}`);
  if (/guide|user guide/.test(descriptor)) return "guide-utilisateur";
  if (/conditions?|acceptation|general conditions/.test(descriptor)) return "conditions-generales";
  if (/formulaire|declaration|signature/.test(descriptor)) return "formulaire";
  return "documentation-operationnelle";
}

function normaliseDescriptor(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function publishedDate(url) {
  const match = /\b(20\d{2})(\d{2})(\d{2})[_-]/.exec(url);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function structuredDate(value) {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? value : null;
}

function externalIdFor(url) {
  return `${EXTRACTOR_ID}:${createHash("sha256").update(url).digest("hex")}`;
}

export function extractEexEmmyDocuments(html, { detectedAt = new Date().toISOString() } = {}) {
  if (typeof html !== "string" || !html.trim()) throw new Error("EEX EMMY extractor received an empty HTML response");
  const byId = new Map();
  const addDocument = (title, href, dateFromPage = null) => {
    if (!href || !title) return;
    let url;
    try { url = canonicalEexUrl(href); } catch { return; }
    if (!eligibleDocument(title, url)) return;
    const externalId = externalIdFor(url);
    if (byId.has(externalId)) return;
    byId.set(externalId, { externalId, title, url, publishedAt: structuredDate(dateFromPage) || publishedDate(url), rawType: rawType(title, url), detectedAt, sourceOfficial: true });
  };

  // The official EEX page publishes each document in a table: the descriptive
  // title and date are sibling cells, while the link label is only the file size.
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const titleCell = /<td\b([^>]*\bdata-field\s*=\s*(?:"title"|'title'|title)[^>]*)>([\s\S]*?)<\/td>/i.exec(row[1]);
    const dateCell = /<td\b([^>]*\bdata-field\s*=\s*(?:"publishing_date"|'publishing_date'|publishing_date)[^>]*)>/i.exec(row[1]);
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(row[1]);
    if (!titleCell || !anchor) continue;
    addDocument(textFromHtml(titleCell[2]), attrValue(anchor[1], "href"), attrValue(dateCell?.[1] || "", "data-date"));
  }

  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrValue(anchor[1], "href");
    const title = textFromHtml(anchor[2]);
    addDocument(title, href);
  }
  const items = [...byId.values()];
  if (!items.length) throw new Error("EEX EMMY extractor found no eligible official documentation");
  return { sourceName: SOURCE_NAME, sourceUrl: SOURCE_URL, items };
}

function baselineRecord(item, previous, seenAt) {
  return { externalId: item.externalId, url: item.url, title: item.title, publishedAt: item.publishedAt, firstSeenAt: previous?.firstSeenAt || seenAt, lastSeenAt: seenAt };
}

export function reconcileEexEmmyDocuments({ extracted, previousItems = {}, pendingItems = [], registryUrls = new Set(), seenAt = new Date().toISOString() }) {
  const previous = previousItems && typeof previousItems === "object" ? previousItems : {};
  const initialBaseline = Object.keys(previous).length === 0;
  const baselineItems = { ...previous };
  const pendingById = new Set(pendingItems.map(item => item?.externalId).filter(Boolean));
  const pendingByUrl = new Set(pendingItems.map(item => item?.url).filter(Boolean));
  const addedPending = [], modified = [];
  let known = 0, newlyExtracted = 0;
  for (const item of extracted.items) {
    const old = previous[item.externalId];
    if (old) {
      known += 1;
      if (old.title !== item.title || old.publishedAt !== item.publishedAt || old.url !== item.url) modified.push({ externalId: item.externalId, titleChanged: old.title !== item.title, dateChanged: old.publishedAt !== item.publishedAt, urlChanged: old.url !== item.url });
    } else {
      newlyExtracted += 1;
      if (!initialBaseline && !pendingById.has(item.externalId) && !pendingByUrl.has(item.url) && !registryUrls.has(item.url)) {
        addedPending.push({ externalId: item.externalId, sourceName: extracted.sourceName, sourceUrl: extracted.sourceUrl, title: item.title, url: item.url, publishedAt: item.publishedAt, rawType: item.rawType, detectedAt: item.detectedAt, status: "pending" });
        pendingById.add(item.externalId);
        pendingByUrl.add(item.url);
      }
    }
    baselineItems[item.externalId] = baselineRecord(item, old, seenAt);
  }
  return { initialBaseline, baselineItems, known, newlyExtracted, modified, addedPending };
}
