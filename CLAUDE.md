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
```

En production : `https://eau.twibox.fr` (exposé par Traefik via le réseau Docker externe `traefik`).

## Architecture

### Deux services Docker
- **web** (nginx) : sert le frontend statique, proxy `/api/` vers le backend (réseaux `traefik` + `backend`)
- **backend** (Node.js/Express) : API SISE-Eaux, télécharge et indexe les CSV dans SQLite (réseau privé `backend` uniquement)

### Frontend — Flux de données hybride (app.js)
1. `loadDepartements()` → API `geo.api.gouv.fr/departements`
2. `loadCommunes(deptCode)` → API `geo.api.gouv.fr/departements/{code}/communes`
3. `loadAnalyses(communeCode)` → **Hub'Eau + SISE-Eaux en parallèle** → fusionne les réseaux
4. `loadNetworkAnalyses(networkCode)` → **fusionne les deux sources** via `mergeAnalyses()` (dédoublonnage par `code_prelevement` + paramètre, SISE prioritaire) : historique long Hub'Eau + valeurs récentes SISE
5. `displayAnalyses(analyses)` → cartes (dernière valeur, min/moy/max sur 12 mois, badge source/date par mesure) + graphiques
6. `updateCalculator()` → calculateur de minéraux

Le frontend vérifie la disponibilité du backend via `checkSiseBackend()` (`/api/sise/health`). Si le backend est indisponible, Hub'Eau est utilisé seul (graceful fallback).

### Sources de données (`DATA_SOURCES`)
- **Hub'Eau** : API publique, appelée directement depuis le navigateur
- **SISE-Eaux** : CSV data.gouv.fr, indexés dans SQLite par le backend, souvent plus récent

### Backend — Sync SISE-Eaux (backend/sync/)
- `downloader.js` : résout via l'API data.gouv les ZIP `dis-AAAA-dept.zip` des `SISE_EAUX_YEARS` (défaut 2) dernières années, ou utilise `SISE_EAUX_ZIP_URL` (liste séparée par des virgules) ; téléchargement en `.part` puis renommage
- `parser.js` : parse les CSV (COM_UDI, PLV, RESULT) en streaming, filtre les paramètres brassage (PARAM_CODES), insère par lots de 10 000
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

### Calculateur de minéraux
`MINERAL_CONVERSIONS` contient les pourcentages de conversion pour 7 sels (gypse, sel d'Epsom, etc.).
`calculateMineralAdditions()` calcule l'impact sur la composition de l'eau en mg/L.

## Stack technique

- **Frontend** : JS vanilla, Tailwind CSS 3 (compilé en multi-stage Docker), Chart.js 3.7 + Luxon 3.4 (CDN+SRI), Font Awesome 6
- **Backend** : Node.js, Express, better-sqlite3, csv-parse, unzipper, node-cron
- **Infra** : nginx:alpine (proxy + headers sécu), node:alpine (backend), volume Docker pour SQLite

## Conventions

- Code et commentaires en **français**
- Sécurité XSS : DOM construit via `document.createElement()` + `textContent`, jamais `innerHTML` avec des données API
- `debug()` est un no-op en production (activable avec `?debug=1`)
- CSS custom dans `src/input.css` (palette "Deep Ocean", glass-effect). Les classes Tailwind dynamiques (couleurs des badges source) sont dans la `safelist` de `tailwind.config.js`
- Le réseau Docker `traefik` doit exister (réseau externe partagé avec le reverse proxy)
- Dépendances verrouillées (`package-lock.json`, `npm ci`) : régénérer le lockfile dans Docker après modification d'un `package.json`
- nginx : ne pas mettre d'`add_header` dans un bloc `location`, sinon les en-têtes de sécurité du bloc `server` ne sont plus hérités
