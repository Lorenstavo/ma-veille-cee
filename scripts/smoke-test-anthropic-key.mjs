#!/usr/bin/env node
// Vérification manuelle que ANTHROPIC_API_KEY est configurée et fonctionnelle, indépendamment
// de update-fiche-details.mjs (qui ne l'exercerait que si une fiche est effectivement
// détectée comme obsolète). N'écrit aucun fichier, ne touche à rien — juste un aller-retour
// minimal vers l'API pour confirmer l'authentification. Modèle Haiku : ce script ne teste que
// l'authentification, pas la qualité d'extraction (qui reste sur claude-opus-5 en production).
//
// N'échoue jamais le job CI (exit 0 dans tous les cas) : ce test tourne uniquement sur
// workflow_dispatch, avant les étapes qui font le vrai travail du jour — un échec ici ne doit
// pas empêcher le run régulier de continuer.

import Anthropic from "@anthropic-ai/sdk";

function log(message) {
  console.log(`[smoke-test] ${message}`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    log("ANTHROPIC_API_KEY absent — rien à tester.");
    return;
  }

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "Réponds uniquement par le mot OK." }]
    });
    const text = response.content.find(b => b.type === "text")?.text?.trim();
    log(`RÉUSSITE — clé valide, réponse du modèle : "${text}"`);
  } catch (err) {
    log(`ÉCHEC — la clé ne fonctionne pas (${err.status || "erreur réseau"}) : ${err.message}`);
  }
}

main();
