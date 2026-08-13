#!/usr/bin/env node

import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const STATE_PATH = path.join(ROOT, "scripts", "data", "regulatory-watch-state.json");
const USER_AGENT = "ma-veille-cee-regulatory-watch/1.0 (+https://ma-veille-cee.fr/)";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const VALID_IMPACTS = new Set(["high", "medium", "low", "info"]);
const DRY_RUN = process.env.DRY_RUN === "true";
const FORCE_RUN = process.env.FORCE_RUN === "true";
const SCHEDULED_RUN_ENABLED = process.env.SCHEDULED_RUN_ENABLED === "true";

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
    if (parsed?.version === 1 && parsed.sources && typeof parsed.sources === "object") return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Existing watch state is invalid");
  }
  return { version: 1, sources: {} };
}

async function checkUrl(url) {
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
      fingerprint: createHash("sha256").update(body).digest("hex")
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

async function checkSources(sources, previousState) {
  const responses = new Map();
  const nextSources = {};
  const results = [];
  for (const source of sources) {
    const key = sourceKey(source.url);
    if (!responses.has(source.url)) {
      try {
        responses.set(source.url, { ok: true, value: await checkUrl(source.url) });
      } catch (error) {
        responses.set(source.url, { ok: false, error: describeRequestError(error) });
      }
    }
    const response = responses.get(source.url);
    if (!response.ok) {
      results.push({ name: source.name, url: source.url, status: "failed", message: response.error });
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
      message: previous ? (changed ? "Content fingerprint changed; human regulatory review required" : "No source-content change detected") : "Initial baseline recorded; no regulatory entry created automatically"
    });
  }
  return { results, nextState: { version: 1, sources: nextSources } };
}

function replaceLastRun(html, rawJson, nextDate) {
  const replacement = rawJson.replace(/("lastRun"\s*:\s*")\d{4}-\d{2}-\d{2(?=")/m, (_match, prefix) => `${prefix}${nextDate}`);
  if (replacement === rawJson) throw new Error("META.lastRun could not be updated safely");
  return html.replace(rawJson, replacement);
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
  log(`Configured sources: ${data.meta.sources.length} (${new Set(data.meta.sources.map(source => source.url)).size} unique URLs)`);

  const { results, nextState } = await checkSources(data.meta.sources, previousState);
  for (const result of results) log(`Source [${result.status}] ${result.name}: ${result.message}`);
  const failed = results.filter(result => result.status === "failed");
  const changedSources = results.filter(result => result.status === "changed");
  const successful = results.length - failed.length;

  log(`Sources succeeded: ${successful}`);
  log(`Sources failed: ${failed.length}`);
  log(`Source-content changes detected: ${changedSources.length}`);
  log("New regulatory entries detected: 0 (V1 has no source-specific extractor)");
  log("Entries added: 0");
  log("Entries modified: 0");

  // Conservative policy: a single source failure invalidates the whole run.
  if (failed.length) throw new Error(`Global run failed: ${failed.length} configured source(s) could not be checked`);

  data.meta.lastRun = paris.date;
  const updatedHtml = replaceLastRun(originalHtml, rawJson, paris.date);
  const finalData = parseEmbeddedData(updatedHtml).data;
  const finalIds = validateData(finalData);
  if (originalIds.size !== finalIds.size || [...originalIds].some(id => !finalIds.has(id))) throw new Error("An existing regulatory entry would disappear; aborting");

  const indexChanged = updatedHtml !== originalHtml;
  const stateChanged = JSON.stringify(nextState) !== JSON.stringify(previousState);
  log(`lastRun updated: ${indexChanged ? "yes" : "no (already current)"}`);
  log(`Run summary state changed: ${stateChanged ? "yes" : "no"}`);

  if (DRY_RUN) {
    log("DRY_RUN complete: no file was modified and no commit will be created.");
    return;
  }

  if (indexChanged) await writeFile(INDEX_PATH, updatedHtml, "utf8");
  if (stateChanged) {
    await mkdir(path.dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }
  log("Run completed successfully. Commit created: pending workflow step.");
}

main().catch(error => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
