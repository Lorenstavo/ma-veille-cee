import { createHash } from "node:crypto";
import https from "node:https";

export const EXTRACTOR_ID = "cour-des-comptes-rss";
export const SOURCE_NAME = "Cour des comptes — RSS publications";
export const SOURCE_URL = "https://www.ccomptes.fr/rss/publications";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const KEYWORDS = [
  { pattern: /\bcertificats? d['’]économies d['’]énergie\b/i, reason: "certificats d'économies d'énergie" },
  { pattern: /\befficacité énergétique\b/i, reason: "efficacité énergétique" },
  { pattern: /\bcee\b/i, reason: "CEE" }
];

function makeError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_match, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)));
}

export function rssText(value) {
  return decodeEntities(String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function tagValue(xml, tagName) {
  const match = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i").exec(xml);
  return match ? rssText(match[1]) : null;
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function canonicalRssUrl(value) {
  if (!validHttpUrl(value)) return null;
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function publishedDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10);
}

export function matchCeeReasons({ title, description }) {
  const haystack = `${title || ""} ${description || ""}`;
  return KEYWORDS.filter(keyword => keyword.pattern.test(haystack)).map(keyword => keyword.reason);
}

function externalIdFor({ guid, url }) {
  const identifier = rssText(guid) || canonicalRssUrl(url);
  if (!identifier) throw makeError("RSS item has neither usable guid nor URL", "ERR_RSS_ITEM_ID");
  return `${EXTRACTOR_ID}:${createHash("sha256").update(identifier).digest("hex")}`;
}

export function extractCourDesComptesRss(xml, { detectedAt = new Date().toISOString() } = {}) {
  if (typeof xml !== "string" || !xml.trim()) throw makeError("RSS response is empty", "ERR_RSS_INVALID_XML");
  if (!/<rss\b[^>]*>/i.test(xml) || !/<channel\b[^>]*>/i.test(xml)) throw makeError("RSS XML root or channel is missing", "ERR_RSS_INVALID_XML");
  const items = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const rawItem = match[1];
    const title = tagValue(rawItem, "title");
    const url = canonicalRssUrl(tagValue(rawItem, "link") || tagValue(rawItem, "guid"));
    const guid = tagValue(rawItem, "guid");
    if (!title || !url) continue;
    const externalId = externalIdFor({ guid, url });
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const description = tagValue(rawItem, "description") || "";
    items.push({
      externalId,
      title,
      url,
      publishedAt: publishedDate(tagValue(rawItem, "pubDate")),
      description,
      matchReasons: matchCeeReasons({ title, description }),
      rawType: "cour-des-comptes-rss",
      detectedAt
    });
  }
  return { sourceName: SOURCE_NAME, sourceUrl: SOURCE_URL, items, empty: items.length === 0 };
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

export function reconcileCourDesComptesRss({ extracted, previousItems = {}, pendingItems = [], registryUrls = new Set(), seenAt = new Date().toISOString() }) {
  const previous = previousItems && typeof previousItems === "object" ? previousItems : {};
  const initialBaseline = Object.keys(previous).length === 0;
  const baselineItems = { ...previous };
  const pendingById = new Set(pendingItems.map(item => item?.externalId).filter(Boolean));
  const pendingByUrl = new Set(pendingItems.map(item => item?.url).filter(Boolean));
  const addedPending = [];
  let known = 0, newlyExtracted = 0;

  for (const item of extracted.items) {
    const old = previous[item.externalId];
    if (old) known += 1;
    else {
      newlyExtracted += 1;
      if (!initialBaseline && item.matchReasons.length && !pendingById.has(item.externalId) && !pendingByUrl.has(item.url) && !registryUrls.has(item.url)) {
        addedPending.push({ externalId: item.externalId, sourceName: extracted.sourceName, sourceUrl: extracted.sourceUrl, title: item.title, url: item.url, publishedAt: item.publishedAt, rawType: item.rawType, matchReasons: item.matchReasons, detectedAt: item.detectedAt, status: "pending" });
        pendingById.add(item.externalId);
        pendingByUrl.add(item.url);
      }
    }
    baselineItems[item.externalId] = baselineRecord(item, old, seenAt);
  }
  return { initialBaseline, baselineItems, known, newlyExtracted, matched: extracted.items.filter(item => item.matchReasons.length).length, addedPending };
}

export async function fetchCourDesComptesRss({ url = SOURCE_URL, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS, requestImpl } = {}) {
  const performRequest = requestImpl || ((requestOptions) => new Promise((resolve, reject) => {
    const request = https.request(requestOptions.url, {
      method: "GET",
      headers: requestOptions.headers,
      family: 4,
      rejectUnauthorized: true
    }, response => {
      const chunks = [];
      let received = 0;
      response.on("data", chunk => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) response.destroy(makeError(`RSS response exceeds ${MAX_RESPONSE_BYTES} bytes`, "ERR_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ statusCode: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks), url: requestOptions.url }));
    });
    request.setTimeout(requestOptions.timeoutMs, () => request.destroy(makeError(`RSS timeout after ${requestOptions.timeoutMs}ms`, "ETIMEDOUT")));
    request.on("error", reject);
    request.end();
  }));
  let currentUrl = url;
  let response;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    response = await performRequest({ url: currentUrl, headers, timeoutMs });
    if (response.statusCode < 300 || response.statusCode >= 400 || !response.headers?.location) break;
    if (redirects === MAX_REDIRECTS) throw makeError("Too many RSS redirects", "ERR_TOO_MANY_REDIRECTS");
    let nextUrl;
    try { nextUrl = new URL(response.headers.location, currentUrl); } catch { throw makeError("Invalid RSS redirect", "ERR_INVALID_REDIRECT"); }
    if (nextUrl.protocol !== "https:") throw makeError("RSS redirect is not HTTPS", "ERR_INVALID_PROTOCOL");
    currentUrl = nextUrl.toString();
  }
  if (response.statusCode < 200 || response.statusCode >= 300) throw makeError(`RSS HTTP ${response.statusCode}`, `HTTP_${response.statusCode}`);
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.includes("xml") && !contentType.includes("rss")) throw makeError("RSS response content type is not XML", "ERR_RSS_CONTENT_TYPE");
  return { statusCode: response.statusCode, bodyText: Buffer.from(response.body).toString("utf8"), finalUrl: response.url || url };
}
