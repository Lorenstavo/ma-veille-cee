// Résout, pour un arrêté CEE déjà confirmé sur Légifrance, son numéro dans la numérotation
// séquentielle informelle du "Ne arrêté modificatif CEE" — une convention suivie par la
// presse spécialisée (Hellio, Sélectra, kelvin°...), jamais publiée par Légifrance lui-même.
// Alimente meta.arreteSeries (onglet "Chronologie normative"), une source distincte de
// meta.items (voir scripts/scan-legifrance-fiche-changes.mjs).
//
// Contrairement au scan Légifrance (restreint à un domaine officiel), cette recherche porte
// nécessairement sur de la presse non officielle : la certitude est donc plus faible que le
// reste du site. Pour limiter le risque d'invention, on exige une citation explicite qui
// numérote CE texte précis (pas une déduction de séquence) et une source de presse identifiée
// parmi une liste fermée de sites spécialisés du secteur CEE — un candidat hors de cette liste,
// sans numéro explicite, ou sans URL de presse concrète est rejeté avant d'atteindre l'appelant.
//
// En cas d'échec ou d'absence de citation exploitable, renvoie `null` : l'appelant doit alors
// laisser la fiche non numérotée (comme le sont déjà, dans meta.arreteSeries, les entrées
// "confirmed": false) plutôt que de deviner un numéro.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
const WEB_SEARCH_MAX_USES = 5;

// Liste fermée, à étendre au besoin : les sites de presse spécialisée CEE déjà cités comme
// source dans ce registre (voir les items existants sourcés "presse spécialisée, à recouper").
const PRESS_DOMAINS = [
  "hellio.com",
  "selectra.info",
  "go-kelvin.com",
  "quotidiag.fr",
  "actu-environnement.com",
  "kwhiz.eu",
  "tucoenergie.fr",
  "koliving.fr",
  "jecalculemoncee.com"
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "num", "pressSourceUrl", "citation"],
  properties: {
    found: { type: "boolean" },
    num: { type: ["integer", "null"], description: "Numéro explicitement cité pour ce texte précis dans la source de presse trouvée." },
    pressSourceUrl: { type: ["string", "null"], description: "URL de la page de presse spécialisée qui cite explicitement ce numéro pour ce texte." },
    citation: { type: ["string", "null"], description: "Courte citation ou paraphrase fidèle de la phrase qui numérote ce texte." }
  }
};

const SYSTEM_PROMPT = `Tu recherches, dans la presse spécialisée française du secteur des Certificats d'Économies d'Énergie (CEE), si un arrêté précis est désigné par un numéro dans une numérotation séquentielle informelle des arrêtés modificatifs du catalogue de fiches CEE (ex. "le 83e arrêté modifiant les fiches...", "83ème arrêté").

Règle absolue : ne retiens un numéro que s'il est explicitement écrit dans une page que tu as consultée, à propos de CE texte précis (même date de signature, même contenu) — jamais déduit d'une séquence, jamais deviné par proximité de date. Si aucune page ne numérote explicitement ce texte, réponds found:false et laisse les autres champs vides plutôt que de deviner.`;

export function isAllowedPressUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return PRESS_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * @param {object} params
 * @param {string} params.jorfUrl - URL Légifrance du texte déjà confirmé.
 * @param {string} params.title - Titre du texte (pour donner le contexte à la recherche).
 * @param {string} params.signatureDate - Date ISO de signature, pour désambiguïser.
 * @param {Anthropic} [params.client] - Client injectable pour les tests.
 * @returns {Promise<{num: number, pressSourceUrl: string, citation: string} | null>}
 */
export async function findInformalSeriesNumber({ jorfUrl, title, signatureDate, client = new Anthropic() }) {
  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      tools: [{
        type: "web_search_20260318",
        name: "web_search",
        max_uses: WEB_SEARCH_MAX_USES,
        allowed_domains: PRESS_DOMAINS
      }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Texte à identifier : "${title}", signé le ${signatureDate}, publié sur ${jorfUrl}.\n\nCe texte est-il désigné par un numéro dans la série informelle des arrêtés modificatifs CEE suivie par la presse spécialisée ?`
      }]
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`[arrete-series-scan] erreur API ${err.status}`, err.message);
    } else {
      console.error(`[arrete-series-scan] erreur réseau/inattendue`, err);
    }
    return null;
  }

  if (response.stop_reason === "refusal") return null;
  const parsed = response.parsed_output;
  if (!parsed || !parsed.found || !Number.isInteger(parsed.num) || parsed.num <= 0) return null;
  if (!parsed.pressSourceUrl || !isAllowedPressUrl(parsed.pressSourceUrl)) {
    console.error(`[arrete-series-scan] candidat écarté : source de presse non reconnue (${parsed.pressSourceUrl})`);
    return null;
  }

  return { num: parsed.num, pressSourceUrl: parsed.pressSourceUrl, citation: parsed.citation || null };
}

export { MODEL, PRESS_DOMAINS };
