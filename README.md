# Application d'Analyse d'Eau pour le Brassage

Cette application web permet d'analyser la qualité de l'eau pour le brassage de bière en France. Elle utilise les données publiques d'analyses d'eau pour fournir des informations détaillées sur la composition de l'eau dans différentes communes.

## Fonctionnalités Principales

### 1. Sélection de la Localisation
- Sélection du département via une liste déroulante
- Sélection de la commune dans le département choisi
- Interface intuitive avec des menus déroulants interconnectés
- Affichage des réseaux d'eau disponibles pour la commune sélectionnée

### 2. Analyse des Paramètres d'Eau
L'application surveille les paramètres clés pour le brassage :

| Paramètre | Unité | Plage Cible |
|-----------|--------|-------------|
| Calcium (Ca) | mg/L | 50-150 |
| Magnésium (Mg) | mg/L | 10-30 |
| Sodium (Na) | mg/L | 0-150 |
| Sulfates (SO4) | mg/L | 50-350 |
| Chlorures | mg/L | 0-250 |
| Potassium (K) | mg/L | 0-10 |
| pH | unité pH | 5.2-8.8 |
| TAC | °f | 0-400 |
| HCO3 | mg/L | 0-400 |

### 3. Visualisation des Données
- Affichage des dernières valeurs mesurées avec code couleur
- Graphiques historiques interactifs pour chaque paramètre
- Indication visuelle des valeurs hors plage cible
- Mise à jour en temps réel des données

### 4. Calculateur de Minéraux
L'application inclut un calculateur avancé pour ajuster la composition de l'eau :

#### Sels Minéraux Supportés
- Sulfate de calcium (Gypse - CaSO₄·2H₂O)
- Sulfate de magnésium (Sel d'Epsom - MgSO₄·7H₂O)
- Chlorure de calcium (CaCl₂·2H₂O)
- Chlorure de sodium (NaCl)
- Carbonate de calcium (Craie - CaCO₃)
- Bicarbonate de sodium (NaHCO₃)
- Chlorure de potassium (KCl)

#### Fonctionnalités du Calculateur
- Calcul en temps réel des modifications de la composition
- Affichage des résultats avant/après ajouts
- Prise en compte du volume d'eau
- Conversion automatique des unités

### 5. Interface Utilisateur
- Design moderne avec effets visuels (fond dégradé, effet verre)
- Interface responsive (adaptée mobile/desktop)
- Gestion des erreurs et des états de chargement
- Version de l'application affichée (v1.2)

### 6. Sources de Données
- API Géo.gouv.fr pour les données géographiques
- API Hub'Eau pour les données d'analyse d'eau
- Calcul automatique des bicarbonates (HCO3) à partir du TAC

## Architecture Technique

### Frontend
- HTML5 / JavaScript vanilla
- Tailwind CSS pour le style
- Chart.js pour les graphiques
- Luxon pour la gestion des dates
- Interface modulaire et réactive

### Backend
- Serveur nginx en conteneur Docker
- Configuration réseau via npm_default network
- Optimisation des performances avec mise en cache

## Déploiement

### Prérequis
- Docker et Docker Compose installés
- Réseau Docker npm_default existant

### Installation
```bash
docker-compose build --no-cache
docker-compose up -d
```

### Accès
L'application est accessible sur :
```
http://localhost:8080
```

## Développement Test-Driven (TDD)
Pour les futures modifications, nous utiliserons une approche TDD :
1. Écriture des tests avant l'implémentation
2. Développement des fonctionnalités
3. Validation des tests
4. Refactoring si nécessaire
