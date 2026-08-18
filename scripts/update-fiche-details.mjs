#!/usr/bin/env node
// Met à jour automatiquement META.ficheDetails quand une fiche déjà documentée dans le
// guide (voir index.html) a une évolution réglementaire plus récente que la dernière
// vérification du guide — même détection que le bandeau "⚠️ à revérifier" côté client
// (index.html : ficheGuideStaleness), ici côté serveur pour décider s'il faut ré-extraire.
//
// Sans ANTHROPIC_API_KEY (pas encore créée), ce script ne fait rien : le bandeau reste le
// seul signal visible, et rien n'est publié à la place d'une vraie extraction — pas de
// contenu inventé pour combler l'absence de clé.
//
// Politique de fusion : un champ que l'extraction renvoie à `null` (information absente du
// document fourni — souvent un arrêté modificatif qui ne répète pas tout le contenu de la
// fiche d'origine) NE remplace PAS la valeur déjà publiée. Seuls les champs effectivement
// trouvés écrasent l'ancienne valeur. Ça évite qu'une extraction partielle efface des
// informations toujours valides.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFicheDetail } from "./sources/fiche-extraction.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "ma-veille-cee-fiche-update/1.0 (+https://ma-veille-cee.fr/)";
const DRY_RUN = process.env.DRY_RUN === "true";

function log(message) {
  console.log(`[fiche-update] ${message}`);
}

export function parseEmbeddedData(html) {
  const match = html.match(/<pre\b[^>]*\bid=["']data-json["'][^>]*>([\s\S]*?)<\/pre>/i);
  if (!match) throw new Error("Embedded #data-json block not found in index.html");
  let data;
  try {
    data = JSON.parse(match[1].trim());
  } catch {
    throw new Error("Embedded regulatory JSON is invalid");
  }
  return { data, rawJson: match[1] };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchSource(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) return { pdfBuffer: buf };
    return { sourceText: stripHtml(buf.toString("utf8")) };
  } finally {
    clearTimeout(timer);
  }
}

export function pickLatestRelatedItem(items, code) {
  const related = (items || []).filter(item => Array.isArray(item.ficheCodes) && item.ficheCodes.includes(code));
  if (!related.length) return null;
  return related.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
}

// Un champ extrait à null/vide ne remplace jamais une valeur déjà publiée : voir le
// commentaire d'en-tête sur la politique de fusion.
export function mergeFicheDetail(oldDetail, extracted) {
  const merged = { ...oldDetail };
  for (const [key, value] of Object.entries(extracted)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  return merged;
}

// Remplace le contenu de `"CODE": { ... }` dans le texte JSON brut par `newDetail`, sans
// re-sérialiser le reste du fichier (préserve le formatage des autres fiches / entrées).
export function replaceFicheDetail(rawJson, code, newDetail) {
  const keyToken = `"${code}": {`;
  const start = rawJson.indexOf(keyToken);
  if (start === -1) throw new Error(`"${code}" introuvable dans ficheDetails`);
  const braceStart = start + keyToken.length - 1;
  let depth = 0, end = -1;
  for (let i = braceStart; i < rawJson.length; i++) {
    if (rawJson[i] === "{") depth++;
    else if (rawJson[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`Objet JSON non fermé pour "${code}"`);
  const serialized = JSON.stringify(newDetail, null, 2).split("\n").join("\n        ");
  return rawJson.slice(0, braceStart) + serialized + rawJson.slice(end);
}

async function main() {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const originalHtml = await readFile(INDEX_PATH, "utf8");
  const { data, rawJson } = parseEmbeddedData(originalHtml);
  const ficheDetails = data.meta.ficheDetails || {};
  const codes = Object.keys(ficheDetails);
  log(`Fiches documentées : ${codes.length}`);

  if (!hasApiKey) {
    log("ANTHROPIC_API_KEY absent — aucune extraction automatique ce run (le bandeau \"à revérifier\" du site reste le seul signal tant que la clé n'est pas configurée).");
    return;
  }

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  let updatedRawJson = rawJson;
  let changed = 0;

  for (const code of codes) {
    const detail = ficheDetails[code];
    const latestItem = pickLatestRelatedItem(data.items, code);
    if (!latestItem || !detail.lastReviewed || latestItem.date <= detail.lastReviewed) continue;
    if (!latestItem.sourceUrl) { log(`${code}: évolution plus récente sans sourceUrl exploitable — ignoré`); continue; }

    log(`${code}: évolution du ${latestItem.date} détectée (guide vérifié le ${detail.lastReviewed}) — tentative via ${latestItem.sourceUrl}`);
    let fetched;
    try {
      fetched = await fetchSource(latestItem.sourceUrl);
    } catch (err) {
      log(`${code}: échec de récupération de la source (${err.message}) — donnée conservée`);
      continue;
    }

    const extracted = await extractFicheDetail({ code, ...fetched });
    if (!extracted) { log(`${code}: extraction sans résultat exploitable — donnée conservée`); continue; }

    const nextDetail = mergeFicheDetail(detail, { ...extracted.data, lastReviewed: today });
    nextDetail.sources = [...(detail.sources || []), { label: latestItem.title, url: latestItem.sourceUrl }];
    updatedRawJson = replaceFicheDetail(updatedRawJson, code, nextDetail);
    changed++;
    log(`${code}: mis à jour automatiquement`);
  }

  if (!changed) { log("Aucune fiche à mettre à jour."); return; }

  const updatedHtml = originalHtml.replace(rawJson, updatedRawJson);
  const reparsed = parseEmbeddedData(updatedHtml); // sécurité : le JSON produit doit rester valide
  const reparsedCodes = Object.keys(reparsed.data.meta.ficheDetails || {});
  if (reparsedCodes.length !== codes.length || codes.some(c => !reparsedCodes.includes(c))) {
    throw new Error("La mise à jour aurait fait disparaître une fiche existante ; abandon sans écriture");
  }

  if (DRY_RUN) { log(`DRY_RUN : ${changed} fiche(s) auraient été mises à jour, aucun fichier modifié.`); return; }
  await writeFile(INDEX_PATH, updatedHtml, "utf8");
  log(`${changed} fiche(s) mise(s) à jour dans index.html.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error(`[fiche-update] ERREUR: ${err.message}`);
    process.exit(1);
  });
}
