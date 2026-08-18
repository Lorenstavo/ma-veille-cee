// Extraction structurée du contenu d'une fiche CEE (ou de l'arrêté qui la modifie) via
// l'API Claude — utilisée par le run CI pour proposer une mise à jour de META.ficheDetails
// quand une fiche déjà documentée est modifiée par un nouvel arrêté.
//
// Principe : extraction fidèle uniquement. Le modèle ne doit jamais calculer, déduire ou
// compléter une valeur absente du document — les champs non trouvés doivent rester `null`.
// Le schéma JSON est volontairement générique (formule + tableau colonnes/lignes) pour
// couvrir n'importe quelle fiche CEE, pas seulement les fiches de type GTB (BAT-TH-116).
//
// En cas d'échec (refus de sécurité, erreur API, sortie non parsée) la fonction renvoie
// `null` : l'appelant doit alors conserver l'ancienne donnée publiée plutôt que d'écrire
// un résultat partiel ou halluciné.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";

// Schéma générique : un tableau {columns, rows} plutôt que des colonnes fixes
// (chauffage/ECS/...), pour rester valable sur des fiches à structure de valorisation
// très différente (isolation : Ki/Kf/S/G : chaudière/PAC : rendements ; etc.).
const FICHE_DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "appliesFrom", "appliesUntil", "scope", "eligibleSectors", "exclusions", "requiredWorks", "valuation", "controlPoints", "justificationDocs"],
  properties: {
    version: { type: ["string", "null"], description: "Identifiant de version de la fiche tel qu'imprimé sur le document (ex. 'v. A62.6')." },
    appliesFrom: { type: ["string", "null"], description: "Date ISO YYYY-MM-DD d'entrée en vigueur, si indiquée explicitement." },
    appliesUntil: { type: ["string", "null"], description: "Date ISO YYYY-MM-DD de fin de validité, si indiquée explicitement." },
    scope: { type: ["string", "null"], description: "Périmètre / définition de l'opération, en français, résumé fidèle du texte — sans reformulation qui ajouterait une condition non écrite." },
    eligibleSectors: { type: ["array", "null"], items: { type: "string" }, description: "Secteurs d'activité éligibles listés explicitement." },
    exclusions: { type: ["array", "null"], items: { type: "string" }, description: "Cas ou surfaces explicitement exclus." },
    requiredWorks: { type: ["array", "null"], items: { type: "string" }, description: "Travaux ou conditions techniques requis, un élément par condition distincte." },
    valuation: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["formula", "formulaVariables", "lifetime", "table", "notes"],
      properties: {
        formula: { type: ["string", "null"], description: "Formule de calcul telle qu'écrite dans le document (ex. 'AE = (Ki - Kf) x S x G')." },
        formulaVariables: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["symbol", "description"],
            properties: {
              symbol: { type: ["string", "null"] },
              description: { type: ["string", "null"] }
            }
          }
        },
        lifetime: { type: ["string", "null"], description: "Durée de vie conventionnelle telle qu'indiquée (ex. '15 ans')." },
        table: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["columns", "rows"],
          description: "Tableau de valorisation le cas échéant, sous forme générique colonnes/lignes.",
          properties: {
            columns: { type: ["array", "null"], items: { type: "string" } },
            rows: {
              type: ["array", "null"],
              items: { type: "array", items: { type: ["string", "number", "null"] } },
              description: "Une ligne par entrée du tableau ; chaque ligne a le même nombre de cellules que 'columns', dans le même ordre."
            }
          }
        },
        notes: { type: ["string", "null"], description: "Coefficients ou précisions numériques hors tableau (ex. coefficients de zone climatique) si non capturés dans 'table'." }
      }
    },
    controlPoints: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["regulationLabel", "regulationUrl", "appliesFrom", "onSiteRate", "contactRate", "nonConformCriteria", "contactChecks"],
      properties: {
        regulationLabel: { type: ["string", "null"], description: "Intitulé de l'arrêté ou du référentiel de contrôle applicable." },
        regulationUrl: { type: ["string", "null"], description: "URL Légifrance ou officielle, uniquement si présente dans le texte fourni — ne jamais inventer une URL." },
        appliesFrom: { type: ["string", "null"] },
        onSiteRate: {
          type: ["array", "null"],
          items: {
            type: "object", additionalProperties: false, required: ["period", "rate"],
            properties: { period: { type: ["string", "null"] }, rate: { type: ["string", "null"] } }
          }
        },
        contactRate: {
          type: ["array", "null"],
          items: {
            type: "object", additionalProperties: false, required: ["period", "rate"],
            properties: { period: { type: ["string", "null"] }, rate: { type: ["string", "null"] } }
          }
        },
        nonConformCriteria: { type: ["array", "null"], items: { type: "string" } },
        contactChecks: { type: ["array", "null"], items: { type: "string" } }
      }
    },
    justificationDocs: { type: ["array", "null"], items: { type: "string" }, description: "Pièces justificatives / documents à réunir, un élément par pièce." }
  }
};

const SYSTEM_PROMPT = `Tu extrais le contenu d'une fiche d'opération standardisée CEE (ou d'un arrêté qui la modifie) vers un JSON structuré.

Règle absolue : extraction fidèle uniquement. Ne calcule rien, ne déduis rien, n'invente aucune valeur ni aucune URL absente du document fourni. Si une information n'est pas présente ou pas certaine, mets null (ou un tableau vide pour les listes) plutôt que de deviner. Ne complète jamais un champ à partir de ta connaissance générale du dispositif CEE — uniquement à partir du texte donné.`;

/**
 * @param {object} params
 * @param {string} params.code - Code de la fiche (ex. "BAT-TH-116"), pour le contexte du prompt.
 * @param {Buffer} [params.pdfBuffer] - Contenu binaire du PDF (fiche officielle ou arrêté), si disponible.
 * @param {string} [params.sourceText] - Texte brut (ex. page Légifrance HTML/texte convertie) —
 *   utilisé uniquement si `pdfBuffer` n'est pas fourni. L'un des deux est obligatoire.
 * @param {Anthropic} [params.client] - Client injectable pour les tests.
 * @returns {Promise<{data: object, usage: object} | null>} `null` en cas d'échec — l'appelant
 *   doit alors conserver la donnée précédemment publiée, jamais écrire un résultat partiel.
 */
export async function extractFicheDetail({ code, pdfBuffer, sourceText, client = new Anthropic() }) {
  const hasPdf = pdfBuffer && pdfBuffer.length;
  const hasText = typeof sourceText === "string" && sourceText.trim().length;
  if (!hasPdf && !hasText) throw new Error("pdfBuffer ou sourceText requis (aucun des deux fourni)");

  const documentBlock = hasPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBuffer.toString("base64") } }
    : { type: "text", text: sourceText };

  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: FICHE_DETAIL_SCHEMA }
      },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          documentBlock,
          { type: "text", text: `Extrait le contenu de la fiche ${code} (ou de l'arrêté la modifiant) ci-joint/ci-dessus selon le schéma demandé.` }
        ]
      }]
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
      // Retryable côté SDK (max_retries par défaut = 2) : si on arrive ici, les retries
      // internes sont épuisés. On ne re-retente pas nous-mêmes ici — le run CI du
      // lendemain retentera naturellement sur la même fiche tant qu'elle reste "changed".
      console.error(`[fiche-extract] ${code}: échec après retries (${err.status})`, err.message);
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[fiche-extract] ${code}: erreur API ${err.status}`, err.message);
    } else {
      console.error(`[fiche-extract] ${code}: erreur réseau/inattendue`, err);
    }
    return null;
  }

  if (response.stop_reason === "refusal") {
    console.error(`[fiche-extract] ${code}: refus (${response.stop_details?.category ?? "catégorie inconnue"})`);
    return null;
  }
  if (response.parsed_output == null) {
    console.error(`[fiche-extract] ${code}: pas de sortie structurée (stop_reason=${response.stop_reason})`);
    return null;
  }

  return { data: response.parsed_output, usage: response.usage };
}

export { FICHE_DETAIL_SCHEMA, MODEL };
