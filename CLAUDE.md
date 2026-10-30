# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projet

Application web d'analyse de qualité d'eau pour le brassage de bière en France. Frontend statique (HTML/JS/CSS) servi par nginx + backend Node.js pour les données SISE-Eaux, le tout via Docker Compose.

## Commandes

```bash
# Build et lancement (Docker) — toujours builder dans Docker, pas en local
docker compose build --no-cache
docker compose up -d

# Forcer une re-synchronisation SISE-Eaux
docker compose exec backend node sync/index.js

# Test de fumée navigateur sur l'application déployée (Chromium headless, nécessite Internet)
docker run --rm --network analyse-eau-brasseur_backend -v "$PWD/e2e:/e2e:ro" \
  mcr.microsoft.com/playwright:v1.48.2-jammy \
  sh -c 'cp /e2e/smoke.js /tmp && cd /tmp && npm i -s playwright@1.48.2 && node smoke.js'
```

Les tests unitaires (`node:test`) s'exécutent pendant `docker compose build` ; un échec interrompt le build :
- `tests/water.test.js` : logique métier frontend (calculs, solveur, fusion des sources)
- `backend/tests/sise.test.js` : import d'un ZIP SISE réduit (`backend/tests/fixtures/dis-test.zip`) puis API

En production : `https://eau.twibox.fr` (exposé par Traefik via le réseau Docker externe `traefik`).

## Architecture

### Deux services Docker
- **web** (nginx) : sert le frontend statique, proxy `/api/` vers le backend (réseaux `traefik` + `backend`)
- **backend** (Node.js/Express) : API SISE-Eaux, télécharge et indexe les CSV dans SQLite (réseau privé `backend` uniquement)

### Frontend — fichiers
- `water.js` : logique métier sans DOM (sources, paramètres, calculs, solveur, fusion) — chargé avant `app.js`, constantes globales partagées, exporté pour les tests Node
- `app.js` : DOM, appels API, graphiques
- `index.html` référence `app.js?v=dev`, `water.js?v=dev`, `styles.css?v=dev` : le Dockerfile remplace `dev` par l'empreinte md5 du fichier ; nginx sert JS/CSS avec un cache d'un an et le HTML en `no-cache`. Ne pas modifier ces numéros à la main

### Frontend — Parcours (app.js)
- Recherche de commune `#communeSearch` (combobox ARIA) : `searchCommunes()` → `geo.api.gouv.fr/communes` (`?nom=` avec `boost=population`, ou `?codePostal=` trié par population) ; « Ma position » → `?lat=&lon=` (`Permissions-Policy: geolocation=(self)`)
- `chooseCommune()` passe l'en-tête en mode compact (`body.has-selection`) et masque l'accueil `#welcome`
- Réseau unique sélectionné automatiquement (`displayNetworks`) ; boutons en `aria-pressed`
- Résultats en onglets `#tabs` (Mon eau / Calculateur / Historique), motif ARIA tablist, onglet actif dans l'URL (`onglet=`)
- Erreurs : `showError(message, retry)` affiche un bouton « Réessayer » ; si **toutes** les sources échouent, c'est une erreur (et non « aucune donnée »)
- Chargement : squelettes `#loading` + annonce `aria-live` (`announce()`)

### Frontend — Flux de données hybride (app.js)
1. `chooseCommune()` / `applySelection()` (lien partagé, dernière visite, exemple)
2. `loadAnalyses(communeCode)` → **Hub'Eau + SISE-Eaux en parallèle** → fusionne les réseaux
3. `loadNetworkAnalyses(networkCode)` → **fusionne les deux sources** via `mergeAnalyses()` (dédoublonnage par `code_prelevement` + paramètre, SISE prioritaire) : historique long Hub'Eau + valeurs récentes SISE
4. `displayAnalyses(analyses)` → onglet « Mon eau » (synthèse, indicateurs, alertes, cartes) + historique
5. `updateCalculator()` → calculateur de minéraux

Le frontend vérifie la disponibilité du backend via `checkSiseBackend()` (`/api/sise/health`). Si le backend est indisponible, Hub'Eau est utilisé seul (graceful fallback).

### Sources de données (`DATA_SOURCES`)
- **Hub'Eau** : API publique, appelée directement depuis le navigateur
- **SISE-Eaux** : CSV data.gouv.fr, indexés dans SQLite par le backend, souvent plus récent

### Backend — Sync SISE-Eaux (backend/sync/)
- `downloader.js` : résout via l'API data.gouv les ZIP `dis-AAAA-dept.zip` des `SISE_EAUX_YEARS` (défaut 2) dernières années, ou utilise `SISE_EAUX_ZIP_URL` (liste séparée par des virgules) ; téléchargement en `.part` puis renommage
- `parser.js` : parse les CSV (COM_UDI, PLV, RESULT) en streaming, filtre les paramètres brassage et qualité (PARAM_CODES), insère par lots de 10 000. Ajouter un code impose une resynchronisation
- `index.js` : orchestre download → import dans DB temp → swap (verrou `data/sync.lock` partagé entre serveur et CLI)
- Sync automatique : au démarrage si pas de DB ou données de plus de 7 jours, puis cron hebdomadaire (dimanche 3h)
- L'API ouvre la base en **lecture seule** et la rouvre automatiquement si le fichier a été remplacé
- Volume Docker `sise-data` pour persister la base SQLite (le conteneur tourne en utilisateur `node`, uid 1000)

### API backend
- `GET /api/sise/communes_udi?code_commune=XXXXX` — réseaux d'une commune
- `GET /api/sise/resultats?code_reseau=XXXXXXXXX&code_parametre=1374,1372,...` — résultats d'analyses (inclut `code_prelevement`, identique à Hub'Eau)
- `GET /api/sise/health` — `{ status: ok|no_data, syncing, last_sync, record_count }` (l'ancienne base reste servie pendant une sync)
- Format de réponse identique à Hub'Eau : `{ count, data: [...] }`

### Paramètres surveillés
Définis dans `PARAMETERS_OF_INTEREST` (app.js) : Ca, Mg, Na, SO4, Cl, K, pH, TAC, HCO3.
HCO3 : valeur mesurée (code SANDRE 1327, ~1/an) complétée par `calculateHCO3()` depuis le TAC pour les autres prélèvements (source virtuelle `CALCULATED_SOURCE`).

`QUALITY_PARAMETERS` (water.js) : chlore libre/total (1398/1399), nitrates (1340), fer et manganèse (1393/1394, **en µg/L**). Pas de graphique : `assessWaterQuality()` produit des alertes (`ok`/`vigilance`/`alerte`) avec conseils (Campden, chloramines…) affichées dans `#qualityAlerts`. Un paramètre jamais mesuré n'est pas affiché.

### Calculateur de minéraux
`MINERAL_CONVERSIONS` contient les pourcentages de conversion pour 7 sels (gypse, sel d'Epsom, etc.), `ION_KEYS` fait le lien élément → paramètre.
`calculateMineralAdditions()` calcule l'impact sur la composition de l'eau en mg/L.

Onglet « Calculateur » : 3 étapes (eau de base et volume, profil cible, sels) + panneau de résultat `#calcPanel` collant sur grand écran.
- Champs générés depuis `SALTS` (app.js, source unique des libellés et unités) avec boutons −/+ ; `MINERAL_INPUT_IDS` et `SALT_UNITS` en dérivent
- **Acides** (en mL), table `ACIDS` (water.js) : `meqPerMl` = acide disponible au pH de maische de référence 5,4 (`MASH_PH_REFERENCE`), `ions` = apports en mg/mL
  - AMS (Murphy & Son, HCl + H2SO4) : densité 1,085, acidité 18,5 % exprimée en H2SO4 → 4,09 meq/mL ; 70,5 mg Cl et 97,7 mg SO4 par mL
  - Phosphorique 75 % (densité 1,579) → 12,27 meq/mL ; lactique 80 % (densité 1,20) → 10,36 meq/mL et 949 mg de lactate/mL (alerte au-delà de `LACTATE_TASTE_THRESHOLD`, 400 mg/L)
  - `calculateMineralAdditions()` neutralise les bicarbonates (bornés à 0, TAC ajusté) ; `acidEffect()` → alcalinité neutralisée et excès d'acide (`#acidHint`)
  - Solveur : option `acid` (sélecteur `#solverAcid`, AMS par défaut) ; acide seulement si la cible demande de baisser les bicarbonates, bicarbonate seulement pour les monter, jamais les deux
- **Empâtage et rinçage** : deux volumes (`#mashVolume`, `#spargeVolume` ; 0 L de rinçage = BIAB) et deux jeux d'ajouts. Les champs d'empâtage gardent l'identifiant simple (`calciumSulfate`), ceux du rinçage sont préfixés (`sparge-calciumSulfate`, via `additionInputId()`). Bascule de saisie `#waterToggle` (`editedWater`)
  - État (`readCalculatorState()`) : `waters.mash`, `waters.sparge`, `waters.kettle` (mélange pondéré par les volumes, `combineWaters()`) ; le panneau affiche l'eau choisie dans `#panelView` (`panelView`, « Ébullition » par défaut : c'est ce profil qui se compare à la cible)
  - Solveur : calcul pour le volume total puis `splitAdditions()` (proportionnelle aux volumes, ou tout dans l'empâtage, `#splitMode`)
  - « Acidifier le rinçage » : `spargeAcidAmount()` neutralise `SPARGE_NEUTRALIZATION` (90 %) de l'alcalinité de l'eau de rinçage avec l'acide de `#solverAcid`
  - Export BeerXML : robinet + empâtage + rinçage ; fiche : ajouts par eau et composition des trois eaux
- `renderIonBars()` : barre de l'eau de base, barre après ajouts colorée selon `profileDeviation()` (water.js), repère de cible ; `renderCompactIndicators()` pour le panneau
- Garder le panneau plus court que la colonne des étapes, sinon il ne peut plus rester collé
- Mobile : résumé fixe `#calcSummaryBar` en bas d'écran, visible seulement quand l'onglet calculateur l'est (il est dans le panneau d'onglet)

### Onglet « Mon eau » (lisibilité)
- Ordre : synthèse `#waterSummary` (`summarizeWater()`), sources, indicateurs, alertes qualité, puis détail `#parameterCards`
- `PARAMETERS_OF_INTEREST` : `label`/`symbol` pour l'affichage (les clés `'CALCIUM (CA)'`… restent les identifiants internes), `range` = repère brassage de la jauge (absent pour pH, TAC, HCO3 : dépend du style), `scale` = échelle fixe (pH)
- Cartes : jauge (`gaugeScale()`/`gaugePosition()`) avec repère, étendue 12 mois et dernière valeur ; mini-courbe SVG masquée sur mobile
- Aide « ? » : `HELP_TEXTS` (water.js) via `createHelp()` ; icônes de statut explicites (`interpretation.icon`, `QUALITY_LEVEL_ICONS`), jamais déduites de la couleur
- Ratio SO4/Cl « peu significatif » si sulfates et chlorures < `LOW_SULFATE_CHLORIDE` (20 mg/L)

### Onglet « Historique »
- Un seul graphique Chart.js (`historyChart`, mis à jour et non recréé) : pastilles de paramètre `#historyParams`, périodes `#historyPeriods` (`HISTORY_PERIODS`, `filterByPeriod()` dans water.js)
- Lignes droites (`tension: 0`), axe Y depuis 0 (échelle fixe pour le pH), points calculés depuis le TAC en cercle vide
- Repère brassage : plugin local `brewingRangePlugin` ; s'il est hors échelle, il est mentionné dans le résumé `#historySummary`

### Indicateurs et profils brassicoles
- `calculateResidualAlkalinity()` (Kolbach, mg/L CaCO3), `calculateSulfateChlorideRatio()`, `calculateIonBalance()` (contrôle de cohérence cations/anions) : affichés pour l'eau du réseau (`#brewingIndicators`) et l'eau modifiée (`#modifiedIndicators`)
- `WATER_PROFILES` : profils cibles indicatifs (villes historiques + styles modernes) ; les profils historiques sont souvent déséquilibrés ioniquement, c'est connu
- `solveMineralAdditions()` : moindres carrés relatifs sous contrainte de positivité (descente par coordonnées) sur `SOLVER_SALTS` ; ne peut qu'ajouter des ions

### Eau de base, export et fiche
- `buildBaseWaters()` : dernière mesure, moyenne ou maximum sur 12 mois (`#baseWaterMode`) ; le solveur et la comparaison suivent l'eau choisie
- `toBeerXmlWaters()` : export BeerXML 1.0 (`<WATERS>`, ions en ppm) de l'eau de base et de l'eau modifiée, téléchargé via Blob
- `#brewSheet` : fiche construite à la demande par `buildBrewSheet()`, seule visible en `@media print` (`src/input.css`)

### Sélection partageable
`saveSelection()` / `restoreSelection()` / `applySelection()` : `?dept=…&commune=…&reseau=…` dans l'URL (lien partageable, rétrocompatible) + dernière sélection en localStorage (`eau-brasseur:selection`). Le libellé de la commune est relu via `geo.api.gouv.fr/communes/{code}`.

## Stack technique

- **Frontend** : JS vanilla, Tailwind CSS 3 (compilé en multi-stage Docker), Chart.js 4.4 + chartjs-adapter-luxon + Luxon 3.4 (CDN+SRI), Font Awesome 6
- **Backend** : Node.js, Express, better-sqlite3, csv-parse, unzipper, node-cron
- **Infra** : nginx:alpine (proxy + headers sécu), node:alpine (backend), volume Docker pour SQLite

## Conventions

- Code et commentaires en **français**
- Sécurité XSS : DOM construit via `document.createElement()` + `textContent`, jamais `innerHTML` avec des données API
- CSP sans `'unsafe-inline'` pour les scripts : aucun `<script>` inline ni attribut `on*=` dans le HTML
- Requêtes réseau avec `AbortSignal.timeout(FETCH_TIMEOUT_MS)` : une source lente ne doit pas bloquer l'autre
- Toute classe Tailwind utilisée en JS doit apparaître en entier dans `app.js` ou `water.js` (fichiers scannés par Tailwind)
- `debug()` est un no-op en production (activable avec `?debug=1`)
- Masquer un élément portant une classe d'affichage Tailwind (`flex`, `inline-flex`…) : basculer la **classe** `hidden`, l'attribut `hidden` serait écrasé
- Icônes Font Awesome : leur `display: inline-block` l'emporte sur la classe Tailwind `hidden` — pour masquer une icône selon la taille d'écran, l'envelopper dans un `<span class="hidden sm:inline">`
- CSS custom dans `src/input.css` (palette "Deep Ocean", glass-effect). Les classes Tailwind dynamiques (couleurs des badges source) sont dans la `safelist` de `tailwind.config.js`
- Le réseau Docker `traefik` doit exister (réseau externe partagé avec le reverse proxy)
- Dépendances verrouillées (`package-lock.json`, `npm ci`) : régénérer le lockfile dans Docker après modification d'un `package.json`
- nginx : ne pas mettre d'`add_header` dans un bloc `location`, sinon les en-têtes de sécurité du bloc `server` ne sont plus hérités
