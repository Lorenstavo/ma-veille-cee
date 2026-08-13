#!/usr/bin/env node

import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACTOR_ID, SOURCE_URL as ECOLOGIE_CEE_SOURCE_URL, extractEcologieCeePublications, reconcileEcologieCeePublications } from "./sources/ecologie-cee.mjs";
import { checkCourDesComptes } from "./sources/cour-des-comptes.mjs";
import { EXTRACTOR_ID as COUR_DES_COMPTES_RSS_EXTRACTOR_ID, SOURCE_URL as COUR_DES_COMPTES_RSS_URL, extractCourDesComptesRss, fetchCourDesComptesRss, reconcileCourDesComptesRss } from "./sources/cour-des-comptes-rss.mjs";
import { checkEcologieGouvFr, isTemporaryEcologieNetworkError } from "./sources/ecologie-gouv-fr.mjs";
import { EXTRACTOR_ID as EEX_EMMY_EXTRACTOR_ID, SOURCE_URL as EEX_EMMY_SOURCE_URL, extractEexEmmyDocuments, reconcileEexEmmyDocuments } from "./sources/eex-emmy-documents.mjs";
import { checkLegifrancePisteConnectivity } from "./sources/legifrance-piste.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const STATE_PATH = path.join(ROOT, "scripts", "data", "regulatory-watch-state.json");
const PENDING_PATH = path.join(ROOT, "scripts", "data", "pending-regulatory-items.json");
const USER_AGENT = "ma-veille-cee-regulatory-watch/1.0 (+https://ma-veille-cee.fr/)";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const VALID_IMPACTS = new Set(["high", "medium", "low", "info"]);
const DRY_RUN = process.env.DRY_RUN === "true";
const FORCE_RUN = process.env.FORCE_RUN === "true";
const SCHEDULED_RUN_ENABLED = process.env.SCHEDULED_RUN_ENABLED === "true";
const LEGIFRANCE_PISTE_CLIENT_ID = process.env.PISTE_LEGIFRANCE_CLIENT_ID;
const LEGIFRANCE_PISTE_CLIENT_SECRET = process.env.PISTE_LEGIFRANCE_CLIENT_SECRET;

// Some public administrations expose IPv6 records that are not consistently
// reachable from hosted CI runners. This changes address preference only; it
// does not bypass an access control or retry around a refusal.
setDefaultResultOrder("ipv4first");

function parisParts(date = new Date()) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    display: `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} Europe/Paris`
  };
}

function log(message) {
  console.log(`[regulatory-watch] ${message}`);
}

function fail(message) {
  console.error(`[regulatory-watch] ERROR: ${message}`);
  process.exit(1);
}

function parseEmbeddedData(html) {
  const match = html.match(/<pre\b[^>]*\bid=["']data-json["'][^>]*>([\s\S]*?)<\/pre>/i);
  if (!match) throw new Error("Embedded #data-json block not found in index.html");
  let data;
  try {
    data = JSON.parse(match[1].trim());
  } catch {
    throw new Error("Embedded regulatory JSON is invalid");
  }
  return { data, rawJson: match[1], match };
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateData(data) {
  if (!data || typeof data !== "object" || !data.meta || !Array.isArray(data.items)) throw new Error("Expected meta and items arrays are missing");
  if (!Array.isArray(data.meta.sources) || !data.meta.sources.length) throw new Error("No configured regulatory sources");
  const ids = new Set();
  for (const item of data.items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) throw new Error("An entry has no stable id");
    if (ids.has(item.id)) throw new Error(`Duplicate regulatory id: ${item.id}`);
    ids.add(item.id);
    if (!VALID_IMPACTS.has(item.impactLevel)) throw new Error(`Invalid impact level for ${item.id}`);
    if (!validHttpUrl(item.sourceUrl)) throw new Error(`Invalid source URL for ${item.id}`);
  }
  for (const source of data.meta.sources) {
    if (!source || typeof source.name !== "string" || !validHttpUrl(source.url)) throw new Error("Invalid configured source URL");
  }
  return ids;
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (parsed?.version === 2 && parsed.sources && typeof parsed.sources === "object" && parsed.extractions && typeof parsed.extractions === "object") return parsed;
    if (parsed?.version === 1 && parsed.sources && typeof parsed.sources === "object") return { version: 2, sources: parsed.sources, extractions: {} };
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Existing watch state is invalid");
  }
  return { version: 2, sources: {}, extractions: {} };
}

async function readPending() {
  try {
    const parsed = JSON.parse(await readFile(PENDING_PATH, "utf8"));
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("Existing pending regulatory items are invalid");
  }
  throw new Error("Existing pending regulatory items are invalid");
}

async function checkUrl(url, { includeBody = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
        "cache-control": "no-cache"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_RESPONSE_BYTES) throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    return {
      finalUrl: response.url,
      etag: response.headers.get("etag") || null,
      lastModified: response.headers.get("last-modified") || null,
      fingerprint: createHash("sha256").update(body).digest("hex"),
      bodyText: includeBody ? body.toString("utf8") : undefined
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
      timeout.code = "ETIMEDOUT";
      timeout.cause = error;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function describeRequestError(error) {
  if (!(error instanceof Error)) return "Unknown request failure";
  const chain = [];
  let current = error;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const details = [
      current.name,
      current.message,
      current.code && `code=${current.code}`,
      current.errno && `errno=${current.errno}`,
      current.syscall && `syscall=${current.syscall}`,
      current.hostname && `hostname=${current.hostname}`,
      current.address && `address=${current.address}`,
      current.port && `port=${current.port}`
    ].filter(Boolean).join("; ");
    chain.push(details);
    current = current.cause;
  }
  return chain.join(" | caused by: ");
}

function sourceKey(url) {
  return createHash("sha256").update(url).digest("hex");
}

async function checkSourceUrl(source) {
  try {
    return { ok: true, value: await checkUrl(source.url, { includeBody: source.url === ECOLOGIE_CEE_SOURCE_URL }) };
  } catch (error) {
    return { ok: false, error: describeRequestError(error), attempts: 1 };
  }
}

function isLegifranceSource(source) {
  return source?.name === "Légifrance (JO, textes CEE)";
}

function isCourDesComptesSource(source) {
  return source?.name === "Cour des comptes — publications CEE";
}

function isEcologieSource(source) {
  try { return new URL(source?.url).hostname === "www.ecologie.gouv.fr"; } catch { return false; }
}

async function checkEcologieSource(source) {
  const result = await checkEcologieGouvFr({
    url: source.url,
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
      "cache-control": "no-cache"
    },
    onAttempt: (attempt, maxAttempts) => log(`ecologie.gouv.fr attempt ${attempt}/${maxAttempts}: ${source.url}`),
    onRetry: () => log("ecologie.gouv.fr retry after temporary network failure")
  });
  if (!result.ok) {
    return {
      ok: false,
      error: describeRequestError(result.error),
      attempts: result.attempts,
      retries: result.retries,
      failureKind: isTemporaryEcologieNetworkError(result.error) ? "host-connectivity-failure" : "source-failure"
    };
  }
  return {
    ok: true,
    value: {
      finalUrl: result.value.finalUrl,
      etag: result.value.etag,
      lastModified: result.value.lastModified,
      fingerprint: createHash("sha256").update(result.value.body).digest("hex"),
      bodyText: source.url === ECOLOGIE_CEE_SOURCE_URL ? result.value.body.toString("utf8") : undefined
    },
    attempts: result.attempts,
    retries: result.retries
  };
}

async function checkCourDesComptesSource(source) {
  const result = await checkCourDesComptes({
    url: source.url,
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
      "cache-control": "no-cache"
    },
    onAttempt: (attempt, maxAttempts) => log(`Cour des comptes attempt ${attempt}/${maxAttempts}`),
    onRetry: () => log("Cour des comptes retry after temporary network failure")
  });
  if (!result.ok) return { ok: false, error: describeRequestError(result.error), attempts: result.attempts };
  return {
    ok: true,
    value: {
      finalUrl: result.value.finalUrl,
      etag: result.value.etag,
      lastModified: result.value.lastModified,
      fingerprint: createHash("sha256").update(result.value.body).digest("hex")
    },
    attempts: result.attempts
  };
}

async function checkCourDesComptesRss() {
  try {
    const response = await fetchCourDesComptesRss({
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
        "cache-control": "no-cache"
      }
    });
    log("Cour des comptes RSS");
    log(`HTTP status: ${response.statusCode}`);
    return { ok: true, value: response };
  } catch (error) {
    log("Cour des comptes RSS");
    log(`Failed: ${describeRequestError(error)}`);
    return { ok: false, error: describeRequestError(error) };
  }
}

async function checkEexEmmyDocuments() {
  try {
    const value = await checkUrl(EEX_EMMY_SOURCE_URL, { includeBody: true });
    log("EEX EMMY documents");
    log("HTTP status: 200");
    return { ok: true, value };
  } catch (error) {
    const message = describeRequestError(error);
    log("EEX EMMY documents");
    log(`Failed: ${message}`);
    return { ok: false, error: message };
  }
}

async function checkLegifrancePisteSource(source) {
  const result = await checkLegifrancePisteConnectivity({ clientId: LEGIFRANCE_PISTE_CLIENT_ID, clientSecret: LEGIFRANCE_PISTE_CLIENT_SECRET, timeoutMs: REQUEST_TIMEOUT_MS });
  const diagnostics = result.diagnostics || {};
  log(`Légifrance PISTE OAuth token obtained: ${diagnostics.oauthTokenObtained ? "yes" : "no"}`);
  log(`Légifrance API endpoint: ${diagnostics.endpoint || "not called"}`);
  if (Number.isInteger(diagnostics.oauthStatus)) log(`Légifrance OAuth HTTP status: ${diagnostics.oauthStatus}`);
  if (Number.isInteger(diagnostics.apiStatus)) log(`Légifrance API HTTP status: ${diagnostics.apiStatus}`);
  if (diagnostics.oauthErrorBody) log(`Légifrance OAuth error body (sanitized): ${diagnostics.oauthErrorBody}`);
  if (diagnostics.apiErrorBody) log(`Légifrance API error body (sanitized): ${diagnostics.apiErrorBody}`);
  if (!result.ok) return { ok: false, error: result.message, attempts: 1 };
  log("Légifrance PISTE authentication: success");
  log("Légifrance API connectivity: success");
  return { ok: true, value: { finalUrl: result.endpoint, etag: null, lastModified: null, fingerprint: createHash("sha256").update("legifrance-piste-connectivity-v1").digest("hex") }, attempts: 1, message: result.message };
}

async function checkSources(sources, previousState) {
  const responses = new Map();
  const nextSources = {};
  const results = [];
  const ecologieSummary = { urlsConfigured: sources.filter(isEcologieSource).length, networkRequestsPerformed: 0, succeeded: 0, failed: 0, retries: 0 };
  for (const source of sources) {
    const key = sourceKey(source.url);
    if (!responses.has(source.url)) {
      const response = isLegifranceSource(source)
        ? await checkLegifrancePisteSource(source)
        : isCourDesComptesSource(source)
          ? await checkCourDesComptesSource(source)
          : isEcologieSource(source)
            ? await checkEcologieSource(source)
            : await checkSourceUrl(source);
      responses.set(source.url, response);
      if (isEcologieSource(source)) {
        ecologieSummary.networkRequestsPerformed += response.attempts || 1;
        ecologieSummary.retries += response.retries || 0;
        if (response.ok) ecologieSummary.succeeded += 1;
        else ecologieSummary.failed += 1;
      }
    }
    const response = responses.get(source.url);
    if (!response.ok) {
      results.push({ name: source.name, url: source.url, status: "failed", message: response.error, attempts: response.attempts || 1, failureKind: response.failureKind || "source-failure", checkedAt: new Date().toISOString() });
      continue;
    }
    const current = response.value;
    const previous = previousState.sources[key];
    const changed = Boolean(previous && previous.fingerprint !== current.fingerprint);
    nextSources[key] = { url: source.url, finalUrl: current.finalUrl, etag: current.etag, lastModified: current.lastModified, fingerprint: current.fingerprint, checkedAt: new Date().toISOString() };
    results.push({
      name: source.name,
      url: source.url,
      status: previous ? (changed ? "changed" : "no-change") : "success",
      message: response.message || (previous ? (changed ? "Content fingerprint changed; human regulatory review required" : "No source-content change detected") : "Initial baseline recorded; no regulatory entry created automatically"),
      attempts: response.attempts || 1,
      checkedAt: new Date().toISOString()
    });
  }
  const hostConnectivityFailures = results.filter(result => result.status === "failed" && isEcologieSource(result) && result.failureKind === "host-connectivity-failure");
  if (hostConnectivityFailures.length > 1) {
    for (const result of hostConnectivityFailures) result.failureKind = "host-connectivity-failure";
    log(`ecologie.gouv.fr host connectivity incident suspected: ${hostConnectivityFailures.length} logical sources failed after ${ecologieSummary.networkRequestsPerformed} network requests`);
  }
  if (ecologieSummary.urlsConfigured) {
    log("ecologie.gouv.fr");
    log(`URLs configured: ${ecologieSummary.urlsConfigured}`);
    log(`network requests performed: ${ecologieSummary.networkRequestsPerformed}`);
    log(`succeeded: ${ecologieSummary.succeeded}`);
    log(`failed: ${ecologieSummary.failed}`);
    log(`retries: ${ecologieSummary.retries}`);
  }
  return { results, nextState: { version: 2, sources: nextSources, extractions: previousState.extractions || {} }, pilotHtml: responses.get(ECOLOGIE_CEE_SOURCE_URL)?.ok ? responses.get(ECOLOGIE_CEE_SOURCE_URL).value.bodyText : null };
}

function replaceLastRun(rawJson, nextDate) {
  const replacement = rawJson.replace(/("lastRun"\s*:\s*")\d{4}-\d{2}-\d{2(?=")/m, (_match, prefix) => `${prefix}${nextDate}`);
  if (replacement === rawJson) throw new Error("META.lastRun could not be updated safely");
  return replacement;
}

function serialiseWatch(watch, newline) {
  return JSON.stringify(watch, null, 2).replace(/\n/g, `${newline}    `);
}

function findJsonValueEnd(text, start) {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") throw new Error("Expected JSON object or array value");
  const closer = opener === "{" ? "}" : "]";
  let depth = 0, string = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (string) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') string = true;
    else if (character === opener) depth++;
    else if (character === closer && --depth === 0) return index + 1;
  }
  throw new Error("Unterminated JSON value");
}

function upsertWatch(rawJson, watch) {
  const newline = rawJson.includes("\r\n") ? "\r\n" : "\n";
  const existing = /\r?\n    "watch"\s*:\s*/.exec(rawJson);
  const serialised = serialiseWatch(watch, newline);
  if (existing) {
    const valueStart = existing.index + existing[0].length;
    const valueEnd = findJsonValueEnd(rawJson, valueStart);
    return `${rawJson.slice(0, valueStart)}${serialised}${rawJson.slice(valueEnd)}`;
  }
  const lastRun = /("lastRun"\s*:\s*"\d{4}-\d{2}-\d{2}"\s*,\r?\n)/.exec(rawJson);
  if (!lastRun) throw new Error("META.lastRun insertion point was not found");
  const insertAt = lastRun.index + lastRun[0].length;
  return `${rawJson.slice(0, insertAt)}    "watch": ${serialised},${newline}${rawJson.slice(insertAt)}`;
}

function buildWatchMetadata({ results, status, completedAt, previousWatch }) {
  const failed = results.filter(result => result.status === "failed");
  const succeeded = results.length - failed.length;
  return {
    version: 1,
    status,
    lastCompletedAt: completedAt,
    lastFullSuccessAt: status === "success" ? completedAt : (typeof previousWatch?.lastFullSuccessAt === "string" ? previousWatch.lastFullSuccessAt : null),
    sourcesConfigured: results.length,
    sourcesSucceeded: succeeded,
    sourcesFailed: failed.length,
    sources: results.map(result => ({
      name: result.name,
      url: result.url,
      status: result.status === "failed" ? "failed" : "success",
      checkedAt: result.checkedAt,
      attempts: result.attempts,
      failureKind: result.failureKind || null,
      message: result.message
    }))
  };
}

function registrySourceUrls(items) {
  const urls = new Set();
  for (const item of items) {
    try {
      const url = new URL(item.sourceUrl);
      url.hash = "";
      urls.add(url.href);
    } catch { /* validateData already rejects invalid registry URLs */ }
  }
  return urls;
}

async function main() {
  const now = new Date();
  const paris = parisParts(now);
  log(`UTC: ${now.toISOString()}`);
  log(`Paris: ${paris.display}`);
  log(`Mode: ${DRY_RUN ? "DRY_RUN" : "WRITE"}; force: ${FORCE_RUN ? "yes" : "no"}`);

  if (!FORCE_RUN && !SCHEDULED_RUN_ENABLED) {
    log("Scheduled execution is gated (repository variable REGULATORY_WATCH_ENABLED is not true); exiting without changes.");
    return;
  }
  if (!FORCE_RUN && paris.hour !== 8) {
    log("Outside the 08:00 Paris execution hour; exiting without changes.");
    return;
  }

  const originalHtml = await readFile(INDEX_PATH, "utf8");
  const { data, rawJson } = parseEmbeddedData(originalHtml);
  const originalIds = validateData(data);
  const previousState = await readState();
  const previousPending = await readPending();
  log(`Configured sources: ${data.meta.sources.length} (${new Set(data.meta.sources.map(source => source.url)).size} unique URLs)`);

  const { results, nextState, pilotHtml } = await checkSources(data.meta.sources, previousState);
  const courDesComptesRss = await checkCourDesComptesRss();
  const eexEmmyDocuments = await checkEexEmmyDocuments();
  const courDesComptesResult = results.find(result => isCourDesComptesSource(result));
  let nextPending = previousPending;
  let extraction = null;
  let courDesComptesRssExtraction = null;
  let eexEmmyExtraction = null;
  const pilotResult = results.find(result => result.url === ECOLOGIE_CEE_SOURCE_URL);
  if (pilotHtml && pilotResult) {
    try {
      const extracted = extractEcologieCeePublications(pilotHtml, { detectedAt: now.toISOString() });
      const previousItems = previousState.extractions?.[EXTRACTOR_ID]?.items || {};
      extraction = reconcileEcologieCeePublications({ extracted, previousItems, pendingItems: previousPending, registryUrls: registrySourceUrls(data.items), seenAt: now.toISOString() });
      nextState.extractions[EXTRACTOR_ID] = { sourceName: extracted.sourceName, sourceUrl: extracted.sourceUrl, items: extraction.baselineItems };
      nextPending = [...previousPending, ...extraction.addedPending];
      log(`Extractor: ${EXTRACTOR_ID}`);
      log(`Items extracted: ${extracted.items.length}`);
      log(`Known: ${extraction.known}`);
      log(`New: ${extraction.initialBaseline ? 0 : extraction.newlyExtracted}`);
      log(`Modified: ${extraction.modified.length}`);
      log(`Pending added: ${extraction.addedPending.length}`);
      log(`Baseline initialized: ${extraction.initialBaseline ? "yes" : "no"}`);
      if (extraction.initialBaseline) log(`Initial baseline created with ${extraction.newlyExtracted} items; no pending items generated.`);
      for (const change of extraction.modified) log(`Modified publication: ${change.externalId} (title=${change.titleChanged ? "yes" : "no"}, date=${change.dateChanged ? "yes" : "no"}, url=${change.urlChanged ? "yes" : "no"})`);
      for (const item of extraction.addedPending) log(`Potential new publication: ${item.title} — ${item.url}`);
    } catch (error) {
      pilotResult.status = "failed";
      pilotResult.message = `Extraction error: ${error instanceof Error ? error.message : "Unknown extractor failure"}`;
      log(`Extraction error for ${EXTRACTOR_ID}: ${pilotResult.message}`);
    }
  } else {
    log(`Extractor: ${EXTRACTOR_ID}`);
    log("Extraction skipped: pilot source was unavailable.");
  }

  if (courDesComptesRss.ok) {
    try {
      const extracted = extractCourDesComptesRss(courDesComptesRss.value.bodyText, { detectedAt: now.toISOString() });
      const previousItems = previousState.extractions?.[COUR_DES_COMPTES_RSS_EXTRACTOR_ID]?.items || {};
      courDesComptesRssExtraction = reconcileCourDesComptesRss({ extracted, previousItems, pendingItems: nextPending, registryUrls: registrySourceUrls(data.items), seenAt: now.toISOString() });
      const manualWrite = FORCE_RUN && !DRY_RUN;
      if (!courDesComptesRssExtraction.initialBaseline || manualWrite) {
        nextState.extractions[COUR_DES_COMPTES_RSS_EXTRACTOR_ID] = { sourceName: extracted.sourceName, sourceUrl: extracted.sourceUrl, items: courDesComptesRssExtraction.baselineItems };
        nextPending = [...nextPending, ...courDesComptesRssExtraction.addedPending];
      }
      log(`Extractor: ${COUR_DES_COMPTES_RSS_EXTRACTOR_ID}`);
      log(`Items extracted: ${extracted.items.length}`);
      log(`CEE matches: ${courDesComptesRssExtraction.matched}`);
      log(`RSS empty: ${extracted.empty ? "yes" : "no"}`);
      log(`New: ${courDesComptesRssExtraction.initialBaseline ? 0 : courDesComptesRssExtraction.newlyExtracted}`);
      log(`Pending added: ${courDesComptesRssExtraction.addedPending.length}`);
      log(`Baseline initialized: ${courDesComptesRssExtraction.initialBaseline ? "yes" : "no"}`);
      if (courDesComptesRssExtraction.initialBaseline) log(`Initial RSS baseline created with ${courDesComptesRssExtraction.newlyExtracted} items; no pending items generated.`);
      if (courDesComptesRssExtraction.initialBaseline && !manualWrite) log("RSS baseline persistence deferred until a manual WRITE workflow run.");
      for (const item of courDesComptesRssExtraction.addedPending) log(`Potential new Cour des comptes publication: ${item.title} — ${item.url}`);
    } catch (error) {
      courDesComptesRss.ok = false;
      courDesComptesRss.error = `RSS extraction error: ${error instanceof Error ? error.message : "Unknown RSS extractor failure"}`;
      log(`Extractor error for ${COUR_DES_COMPTES_RSS_EXTRACTOR_ID}: ${courDesComptesRss.error}`);
    }
  }

  if (eexEmmyDocuments.ok) {
    try {
      const extracted = extractEexEmmyDocuments(eexEmmyDocuments.value.bodyText, { detectedAt: now.toISOString() });
      const previousItems = previousState.extractions?.[EEX_EMMY_EXTRACTOR_ID]?.items || {};
      eexEmmyExtraction = reconcileEexEmmyDocuments({ extracted, previousItems, pendingItems: nextPending, registryUrls: registrySourceUrls(data.items), seenAt: now.toISOString() });
      nextState.extractions[EEX_EMMY_EXTRACTOR_ID] = { sourceName: extracted.sourceName, sourceUrl: extracted.sourceUrl, items: eexEmmyExtraction.baselineItems };
      nextPending = [...nextPending, ...eexEmmyExtraction.addedPending];
      log(`Extractor: ${EEX_EMMY_EXTRACTOR_ID}`);
      log(`Items extracted: ${extracted.items.length}`);
      log(`Known: ${eexEmmyExtraction.known}`);
      log(`New: ${eexEmmyExtraction.initialBaseline ? 0 : eexEmmyExtraction.newlyExtracted}`);
      log(`Modified: ${eexEmmyExtraction.modified.length}`);
      log(`Pending added: ${eexEmmyExtraction.addedPending.length}`);
      log(`Baseline initialized: ${eexEmmyExtraction.initialBaseline ? "yes" : "no"}`);
      if (eexEmmyExtraction.initialBaseline) log(`Initial EEX documentation baseline created with ${eexEmmyExtraction.newlyExtracted} documents; no pending items generated.`);
      for (const item of eexEmmyExtraction.addedPending) log(`Potential new EEX documentation: ${item.title} — ${item.url}`);
    } catch (error) {
      eexEmmyDocuments.ok = false;
      eexEmmyDocuments.error = `EEX extraction error: ${error instanceof Error ? error.message : "Unknown extractor failure"}`;
      log(`Extractor error for ${EEX_EMMY_EXTRACTOR_ID}: ${eexEmmyDocuments.error}`);
    }
  }

  if (courDesComptesResult) {
    if (!courDesComptesResult.status || courDesComptesResult.status === "failed") {
      if (courDesComptesRss.ok) {
        courDesComptesResult.status = "success";
        courDesComptesResult.message = "RSS official channel available; publication page unavailable";
        courDesComptesResult.failureKind = null;
        const key = sourceKey(courDesComptesResult.url);
        nextState.sources[key] = {
          url: courDesComptesResult.url,
          finalUrl: courDesComptesRss.value.finalUrl,
          etag: null,
          lastModified: null,
          fingerprint: createHash("sha256").update(courDesComptesRss.value.bodyText).digest("hex"),
          checkedAt: new Date().toISOString(),
          channel: "rss"
        };
      } else {
        courDesComptesResult.message = `${courDesComptesResult.message}; RSS unavailable: ${courDesComptesRss.error}`;
      }
    } else if (!courDesComptesRss.ok) {
      courDesComptesResult.message = `${courDesComptesResult.message}; RSS degraded: ${courDesComptesRss.error}`;
    } else {
      courDesComptesResult.message = `${courDesComptesResult.message}; RSS official channel available`;
    }
  }

  for (const result of results) log(`Source [${result.status}] ${result.name}: ${result.message}`);
  const failed = results.filter(result => result.status === "failed");
  const changedSources = results.filter(result => result.status === "changed");
  const successful = results.length - failed.length;

  log(`Sources succeeded: ${successful}`);
  log(`Sources failed: ${failed.length}`);
  log(`Source-content changes detected: ${changedSources.length}`);
  log(`New regulatory entries detected: 0 (pending technical review: ${(extraction?.addedPending.length || 0) + (courDesComptesRssExtraction?.addedPending.length || 0) + (eexEmmyExtraction?.addedPending.length || 0)})`);
  log("Entries added: 0");
  log("Entries modified: 0");

  if (!successful) throw new Error("Global run failed: no configured source could be checked");

  const status = failed.length ? "partial" : "success";
  const completedAt = now.toISOString();
  const watch = buildWatchMetadata({ results, status, completedAt, previousWatch: data.meta.watch });
  log(`Global status: ${status}`);

  let updatedRawJson = status === "success" ? replaceLastRun(rawJson, paris.date) : rawJson;
  updatedRawJson = upsertWatch(updatedRawJson, watch);
  const updatedHtml = originalHtml.replace(rawJson, updatedRawJson);
  const finalData = parseEmbeddedData(updatedHtml).data;
  const finalIds = validateData(finalData);
  if (originalIds.size !== finalIds.size || [...originalIds].some(id => !finalIds.has(id))) throw new Error("An existing regulatory entry would disappear; aborting");

  const indexChanged = updatedHtml !== originalHtml;
  const stateChanged = JSON.stringify(nextState) !== JSON.stringify(previousState);
  const pendingChanged = JSON.stringify(nextPending) !== JSON.stringify(previousPending);
  log(`lastRun updated: ${status === "success" ? "yes" : "no (partial control)"}`);
  log(`Run summary state changed: ${stateChanged ? "yes" : "no"}`);
  log(`Pending queue changed: ${pendingChanged ? "yes" : "no"}`);

  if (DRY_RUN) {
    log("DRY_RUN complete: no file was modified and no commit will be created.");
    return;
  }

  if (indexChanged) await writeFile(INDEX_PATH, updatedHtml, "utf8");
  if (stateChanged) {
    await mkdir(path.dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }
  if (pendingChanged) await writeFile(PENDING_PATH, `${JSON.stringify(nextPending, null, 2)}\n`, "utf8");
  log("Run completed successfully. Commit created: pending workflow step.");
}

main().catch(error => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
