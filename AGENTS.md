# ma-veille-cee — pipeline de mise à jour automatique

Ce dépôt génère `index.html` (veille CEE France) et `cae-espagne/index.html` (veille CAE
Espagne), publiés automatiquement (Netlify, auto-publish sur `main`). Deux workflows GitHub
Actions tournent chaque jour : `regulatory-watch.yml` et `cae-watch.yml`.

## Règle permanente (posée le 2026-08-24)

**Quand une fiche d'opération standardisée déjà documentée dans le catalogue
(`meta.ficheDetails` dans `index.html`) est modifiée par un nouveau texte réglementaire,
la mise à jour doit être répercutée automatiquement sur le catalogue des fiches et sur
tout ce qui en dépend sur le site — sans attendre qu'un humain la repère manuellement.**

Cette règle est appliquée par l'enchaînement suivant, dans `regulatory-watch.yml`, à chaque
run (quotidien ou manuel) :

1. **`run-regulatory-watch.mjs`** — vérifie les sources officielles configurées
   (ecologie.gouv.fr, PNCEE, Légifrance PISTE, consultations publiques, etc.) et signale un
   changement de fingerprint sur une page ; ne crée pas d'item de registre lui-même.
2. **`scan-legifrance-fiche-changes.mjs`** (IA, nécessite `ANTHROPIC_API_KEY`) — recherche
   activement, via l'outil de recherche web hébergé de l'API Claude restreint au domaine
   legifrance.gouv.fr, tout arrêté récent (14 derniers jours) modifiant l'une des fiches déjà
   présentes dans `meta.ficheDetails`. Si un texte est trouvé et confirmé (jamais d'URL ou de
   contenu inventé — voir `scripts/sources/legifrance-fiche-scan.mjs`), il ajoute l'item de
   registre correspondant dans `meta.items`. Idempotent par `sourceUrl` : un texte déjà au
   registre n'est jamais ajouté deux fois.
3. **`update-fiche-details.mjs`** (IA, nécessite `ANTHROPIC_API_KEY`) — détecte qu'un item de
   registre plus récent que `ficheDetails[code].lastReviewed` existe pour un code donné
   (staleness check, la même logique que le bandeau "à revérifier" côté client) et ré-extrait
   automatiquement le contenu de la fiche à jour à partir de la source officielle.
4. Un seul commit final regroupe tous les changements accumulés par les trois étapes et les
   pousse sur `main` (auto-publication totale, sans garde-fou humain — décision du
   2026-08-17 : voir l'historique de commits).

L'étape 2 alimente aussi, en best-effort, la **Chronologie normative** (`meta.arreteSeries`,
onglet séparé du site) : pour chaque texte confirmé sur Légifrance, elle tente de résoudre son
numéro dans la numérotation séquentielle informelle des arrêtés modificatifs CEE (une
convention suivie uniquement par la presse spécialisée — Hellio, Sélectra... — jamais publiée
par Légifrance) via `scripts/sources/arrete-series-scan.mjs`, restreint à une liste fermée de
domaines de presse spécialisée. Un texte dont le numéro n'est pas explicitement trouvé reste
non numéroté (`"confirmed": false`, comme les entrées déjà présentes de longue date) plutôt que
de deviner — cette source est structurellement moins certaine que le reste du site (presse, pas
texte officiel), donc l'exigence "jamais de contenu inventé" y est appliquée avec un filtre
supplémentaire (URL de presse dans une liste fermée + citation explicite exigée).

**Portée actuelle : uniquement les fiches déjà présentes dans `meta.ficheDetails`** (6 au
2026-08-24 : BAT-TH-116, BAR-EN-101, BAR-TH-171, BAR-TH-174, BAR-EN-102, BAR-TH-148). Étendre
cette couverture à l'ensemble du catalogue (~200 fiches) est un chantier séparé (populer
`meta.ficheDetails` fiche par fiche) — une fois une fiche ajoutée au catalogue, elle bénéficie
automatiquement de cette routine de mise à jour sans code supplémentaire à écrire.

**Sans `ANTHROPIC_API_KEY`**, les étapes 2 et 3 ne font rien et ne modifient aucun fichier
(pas de contenu inventé pour combler l'absence de clé) — seul le fingerprinting brut de
l'étape 1 reste actif.

## Garde-fou de contenu

`content-guard.yml` (déclenché sur tout push touchant `index.html` ou
`cae-espagne/index.html`) vérifie que le JSON embarqué reste valide et que la taille/le
nombre d'items n'ont pas chuté anormalement, et restaure automatiquement le contenu précédent
sinon — voir `scripts/guard-content-integrity.mjs`. Protège contre un écrasement accidentel
quelle que soit sa source (workflow de ce dépôt, ou tout autre processus poussant sur `main`,
par ex. un déploiement Cloudflare Pages parallèle identifié le 2026-08-24).

## Conventions à respecter pour toute modification manuelle de `index.html`

- Ne jamais réformater tout le fichier : `index.html` contient un bloc JSON hand-formaté
  (`<pre id="data-json">`) édité par des splices texte byte-précises (voir
  `replaceFicheDetail` et `insertRegistryItems`), pas par un `JSON.stringify` global.
- Aucune donnée inventée : un champ non confirmé par une source officielle reste `null`
  (ou absent), jamais deviné.
- Toujours valider après édition : JSON re-parsable, `node scripts/guard-content-integrity.mjs`,
  `node --test tests/`.
