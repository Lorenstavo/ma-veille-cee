// Détection automatique des arrêtés modifiant une fiche CEE déjà documentée dans le
// catalogue (voir index.html, meta.ficheDetails) — utilisée par le run CI pour proposer un
// nouvel item de registre sans intervention manuelle (voir scripts/scan-legifrance-fiche-changes.mjs).
//
// Principe : recherche web hébergée côté API Claude, restreinte au domaine officiel
// legifrance.gouv.fr, puis rédaction d'un item de registre structuré à partir du texte
// réellement consulté. Jamais de contenu inventé : un candidat dont l'URL retournée ne
// pointe pas vers legifrance.gouv.fr est rejeté avant même d'atteindre l'appelant (voir
// isOfficialLegifranceUrl), et le modèle est explicitement instruit de laisser un champ
// vide plutôt que de deviner.
//
// En cas d'échec (refus de sécurité, erreur API, sortie non parsée, recherche infructueuse)
// la fonction renvoie un tableau vide : l'appelant doit alors considérer qu'aucun changement
// n'a été trouvé ce run, jamais écrire un résultat partiel ou halluciné.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
const WEB_SEARCH_MAX_USES = 6;
const OFFICIAL_HOSTS = new Set(["legifrance.gouv.fr", "www.legifrance.gouv.fr"]);

const ACTOR_IMPACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["level", "text"],
  properties: {
    level: { type: "string", enum: ["info", "low", "medium", "high"] },
    text: { type: "string", description: "Conseil concret et actionnable pour ce profil, fondé strictement sur le texte réellement consulté." }
  }
};

const CHANGES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["changes"],
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ficheCodes", "sourceUrl", "signatureDate", "effectiveDate", "impactLevel", "title", "summary", "impactText", "actorImpacts"],
        properties: {
          ficheCodes: { type: "array", items: { type: "string" }, description: "Codes de fiches d'opération standardisée réellement modifiés par ce texte, parmi ceux demandés." },
          sourceUrl: { type: "string", description: "URL Légifrance exacte du texte consulté (jamais une URL de recherche, de sommaire ou approximative)." },
          signatureDate: { type: ["string", "null"], description: "Date de signature de l'arrêté, au format ISO YYYY-MM-DD, si trouvée." },
          effectiveDate: { type: ["string", "null"], description: "Date d'entrée en vigueur des dispositions, au format ISO YYYY-MM-DD, si trouvée." },
          impactLevel: { type: "string", enum: ["low", "medium", "high"] },
          title: { type: "string", description: "Titre du texte, dans le style 'Arrêté du <date> — <résumé bref>'." },
          summary: { type: "string", description: "Résumé fidèle des modifications apportées, en français, sans ajouter de condition non écrite dans le texte." },
          impactText: { type: "string", description: "Ce que ce texte change concrètement, avec ses dates et ses dispositions transitoires si elles existent." },
          actorImpacts: {
            type: "object",
            additionalProperties: false,
            required: ["delegataireMandataire", "bureauControle", "professionnel"],
            properties: {
              delegataireMandataire: ACTOR_IMPACT_SCHEMA,
              bureauControle: ACTOR_IMPACT_SCHEMA,
              professionnel: ACTOR_IMPACT_SCHEMA
            }
          }
        }
      }
    }
  }
};

const SYSTEM_PROMPT = `Tu es un veilleur réglementaire du dispositif français des Certificats d'Économies d'Énergie (CEE).

Règle absolue : ne t'appuie que sur les pages legifrance.gouv.fr que tu consultes réellement via la recherche web fournie. N'invente jamais une URL, une date ou un contenu — si une information n'est pas confirmée par un texte que tu as consulté, laisse le champ correspondant vide (chaîne vide) plutôt que de deviner. Ne retiens un texte que s'il modifie explicitement au moins un des codes de fiche demandés. Si aucun texte pertinent n'est trouvé, réponds avec un tableau "changes" vide plutôt que de forcer un résultat.`;

export function isOfficialLegifranceUrl(url) {
  try {
    return OFFICIAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {object} params
 * @param {string[]} params.ficheCodes - Codes de fiches déjà documentées à surveiller.
 * @param {string} params.sinceDate - Date ISO YYYY-MM-DD : ne considérer que les textes publiés à partir de cette date.
 * @param {Anthropic} [params.client] - Client injectable pour les tests.
 * @returns {Promise<Array<object>>} Liste de changements trouvés (jamais null) ; tableau vide si rien
 *   n'est trouvé ou en cas d'échec — l'appelant ne doit jamais traiter une liste vide comme une erreur bloquante.
 */
export async function findRecentFicheChanges({ ficheCodes, sinceDate, client = new Anthropic() }) {
  if (!Array.isArray(ficheCodes) || !ficheCodes.length) return [];

  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: 12000,
      tools: [{
        type: "web_search_20260318",
        name: "web_search",
        max_uses: WEB_SEARCH_MAX_USES,
        allowed_domains: ["legifrance.gouv.fr", "www.legifrance.gouv.fr"]
      }],
      output_config: {
        format: { type: "json_schema", schema: CHANGES_SCHEMA }
      },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Recherche tout arrêté publié au Journal officiel à compter du ${sinceDate} qui modifie l'une des fiches d'opérations standardisées CEE suivantes : ${ficheCodes.join(", ")}.

Pour chaque texte trouvé et confirmé, rédige un item de veille réglementaire complet selon le schéma demandé (résumé, impact concret, conseil par profil : délégataire/mandataire CEE, bureau de contrôle, professionnel RGE).`
      }]
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
      console.error(`[legifrance-scan] échec après retries (${err.status})`, err.message);
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[legifrance-scan] erreur API ${err.status}`, err.message);
    } else {
      console.error(`[legifrance-scan] erreur réseau/inattendue`, err);
    }
    return [];
  }

  if (response.stop_reason === "refusal") {
    console.error(`[legifrance-scan] refus (${response.stop_details?.category ?? "catégorie inconnue"})`);
    return [];
  }
  if (response.parsed_output == null || !Array.isArray(response.parsed_output.changes)) {
    console.error(`[legifrance-scan] pas de sortie structurée exploitable (stop_reason=${response.stop_reason})`);
    return [];
  }

  return response.parsed_output.changes.filter(change => {
    if (!change || typeof change !== "object") return false;
    if (!isOfficialLegifranceUrl(change.sourceUrl)) {
      console.error(`[legifrance-scan] candidat écarté : URL non officielle (${change.sourceUrl})`);
      return false;
    }
    if (!Array.isArray(change.ficheCodes) || !change.ficheCodes.length) return false;
    if (!change.signatureDate || !ISO_DATE_RE.test(change.signatureDate)) {
      console.error(`[legifrance-scan] candidat écarté : signatureDate absente/invalide (${change.sourceUrl})`);
      return false;
    }
    return true;
  });
}

export { MODEL, CHANGES_SCHEMA };
