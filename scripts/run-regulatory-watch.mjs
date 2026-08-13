#!/usr/bin/env node

import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACTOR_ID, SOURCE_URL as ECOLOGIE_CEE_SOURCE_URL, extractEcologieCeePublications, reconcileEcologieCeePublications } from "./sources/ecologie-cee.mjs";
import { checkLegifrancePisteConnectivity } from "./sources/legifrance-piste.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const STATE_PATH = path.join(ROOT, "scripts", "data", "regulatory-watch-state.json");
const PENDING_PATH = path.join(ROOT, "scripts", "data", "pending-regulatory-items.json");
const USER_AGENT = "ma-veille-cee-regulatory-watch/1.0 (+https://ma-veille-cee.fr/)";
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_500;
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isTemporaryNetworkError(message) {
  return /\b(UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET)\b/.test(message);
}

async function checkSourceUrl(source) {
  try {
    return { ok: true, value: await checkUrl(source.url, { includeBody: source.url === ECOLOGIE_CEE_SOURCE_URL }) };
  } catch (error) {
    const message = describeRequestError(error);
    const mayRetry = source.url.includes("ccomptes.fr") && isTemporaryNetworkError(message);
    if (!mayRetry) return { ok: false, error: message, attempts: 1 };
    log(`Retrying ${source.name} after a temporary network failure`);
    await delay(RETRY_DELAY_MS);
    try {
      return { ok: true, value: await checkUrl(source.url, { includeBody: source.url === ECOLOGIE_CEE_SOURCE_URL }), attempts: 2 };
    } catch (retryError) {
      return { ok: false, error: describeRequestError(retryError), attempts: 2 };
    }
  }
}

function isLegifranceSource(source) {
  return source?.name === "Légifrance (JO, textes CEE)";
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
  for (const source of sources) {
    const key = sourceKey(source.url);
    if (!responses.has(source.url)) {
      responses.set(source.url, isLegifranceSource(source) ? await checkLegifrancePisteSource(source) : await checkSourceUrl(source));
    }
    const response = responses.get(source.url);
    if (!response.ok) {
      results.push({ name: source.name, url: source.url, status: "failed", message: response.error, attempts: response.attempts || 1, checkedAt: new Date().toISOString() });
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
  let nextPending = previousPending;
  let extraction = null;
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

  for (const result of results) log(`Source [${result.status}] ${result.name}: ${result.message}`);
  const failed = results.filter(result => result.status === "failed");
  const changedSources = results.filter(result => result.status === "changed");
  const successful = results.length - failed.length;

  log(`Sources succeeded: ${successful}`);
  log(`Sources failed: ${failed.length}`);
  log(`Source-content changes detected: ${changedSources.length}`);
  log(`New regulatory entries detected: 0 (pending technical review: ${extraction?.addedPending.length || 0})`);
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
