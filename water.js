// Logique métier sans DOM : sources, paramètres, calculs brassicoles, fusion des analyses.
// Chargé avant app.js dans le navigateur (constantes globales partagées) et importé par les tests Node.

// Formats des codes de sélection (département, commune, réseau)
const SELECTION_PATTERNS = { dept: /^[0-9AB]{2,3}$/i, commune: /^[0-9AB]{5}$/i, reseau: /^[0-9AB]{9}$/i };

// Garder uniquement les codes au format attendu
const sanitizeSelection = (selection) => {
    const clean = {};
    Object.entries(SELECTION_PATTERNS).forEach(([key, pattern]) => {
        if (typeof selection[key] === 'string' && pattern.test(selection[key])) clean[key] = selection[key];
    });
    return clean;
};

// Sources de données
const DATA_SOURCES = {
    HUBEAU: {
        id: 'hubeau',
        name: 'Hub\'Eau',
        fullName: 'Hub\'Eau (eaufrance.fr)',
        description: 'API publique du BRGM — rediffusion mensuelle des données SISE-Eaux',
        icon: 'fas fa-water',
        color: 'sky'
    },
    SISE_EAUX: {
        id: 'sise-eaux',
        name: 'SISE-Eaux',
        fullName: 'SISE-Eaux (data.gouv.fr)',
        description: 'Base du Ministère de la Santé — données M+1, plus récentes',
        icon: 'fas fa-database',
        color: 'emerald'
    }
};

// Paramètres d'intérêt pour la bière
// label/symbol : affichage ; range : repère usuel en brassage (après ajouts éventuels), absent quand il dépend
// du style ; scale : échelle fixe de la jauge (sinon calculée) ; target : plage du calculateur
const PARAMETERS_OF_INTEREST = {
    'CALCIUM (CA)': { code: '1374', unit: 'mg/L', label: 'Calcium', symbol: 'Ca²⁺', range: { min: 50, max: 150 }, target: { min: 50, max: 150 } },
    'MAGNESIUM (MG)': { code: '1372', unit: 'mg/L', label: 'Magnésium', symbol: 'Mg²⁺', range: { min: 10, max: 30 }, target: { min: 10, max: 30 } },
    'SODIUM (NA)': { code: '1375', unit: 'mg/L', label: 'Sodium', symbol: 'Na⁺', range: { min: 0, max: 100 }, target: { min: 0, max: 150 } },
    'SULFATES (SO4)': { code: '1338', unit: 'mg/L', label: 'Sulfates', symbol: 'SO₄²⁻', range: { min: 50, max: 350 }, target: { min: 50, max: 350 } },
    'CHLORURES': { code: '1337', unit: 'mg/L', label: 'Chlorures', symbol: 'Cl⁻', range: { min: 0, max: 150 }, target: { min: 0, max: 250 } },
    'POTASSIUM (K)': { code: '1367', unit: 'mg/L', label: 'Potassium', symbol: 'K⁺', range: { min: 0, max: 10 }, target: { min: 0, max: 10 } },
    'PH': { code: '1302', unit: 'unité pH', label: 'pH', symbol: '', scale: { min: 6, max: 9 }, target: { min: 6.5, max: 9 } },
    'TAC': { code: '1347', unit: '°f', label: 'Alcalinité (TAC)', symbol: '', target: { min: 0, max: 40 } },
    'HCO3': { code: '1327', unit: 'mg/L', label: 'Bicarbonates', symbol: 'HCO₃⁻', target: { min: 0, max: 400 } }
};

// Constantes pour les conversions de minéraux
const MINERAL_CONVERSIONS = {
    calciumSulfate: { // CaSO4·2H2O (Gypse)
        ca: 0.2324, // 23.24% de calcium
        so4: 0.5570 // 55.70% de sulfate
    },
    magnesiumSulfate: { // MgSO4·7H2O (Sel d'Epsom)
        mg: 0.0986, // 9.86% de magnésium
        so4: 0.3900 // 39.00% de sulfate
    },
    calciumChloride: { // CaCl2·2H2O
        ca: 0.2726, // 27.26% de calcium
        cl: 0.4823  // 48.23% de chlorure
    },
    sodiumChloride: { // NaCl (Sel de table)
        na: 0.3934, // 39.34% de sodium
        cl: 0.6066  // 60.66% de chlorure
    },
    calciumCarbonate: { // CaCO3 (Craie)
        ca: 0.4004, // 40.04% de calcium
        hco3: 1.2193 // 2 HCO3 par CaCO3 (dissolution avec CO2) — la craie est peu soluble dans l'eau
    },
    sodiumBicarbonate: { // NaHCO3 (Bicarbonate de soude)
        na: 0.2736, // 27.36% de sodium
        hco3: 0.7264 // 72.64% de bicarbonate
    },
    potassiumChloride: { // KCl
        k: 0.5244,  // 52.44% de potassium
        cl: 0.4756  // 47.56% de chlorure
    }
};

// Correspondance élément (MINERAL_CONVERSIONS) → paramètre affiché
const ION_KEYS = {
    ca: 'CALCIUM (CA)',
    mg: 'MAGNESIUM (MG)',
    na: 'SODIUM (NA)',
    k: 'POTASSIUM (K)',
    so4: 'SULFATES (SO4)',
    cl: 'CHLORURES',
    hco3: 'HCO3'
};

// Fonction pour calculer les concentrations après ajout de minéraux
function calculateMineralAdditions(baseWater, additions, waterQuantity) {
    const result = { ...baseWater };
    const liters = parseFloat(waterQuantity);
    if (!(liters > 0)) return result;

    Object.entries(additions).forEach(([mineral, grams]) => {
        if (!(grams > 0) || !MINERAL_CONVERSIONS[mineral]) return;
        for (const [element, percentage] of Object.entries(MINERAL_CONVERSIONS[mineral])) {
            const key = ION_KEYS[element];
            result[key] = (result[key] || 0) + (grams * percentage * 1000) / liters; // Conversion g -> mg/L
        }
    });

    return result;
}

// Ions comparés aux profils cibles
const PROFILE_IONS = ['CALCIUM (CA)', 'MAGNESIUM (MG)', 'SODIUM (NA)', 'SULFATES (SO4)', 'CHLORURES', 'HCO3'];

// Profils d'eau de référence (mg/L) — valeurs indicatives couramment citées en brassage
const WATER_PROFILES = {
    pilsen: { name: 'Pilsen', description: 'Eau très douce — pils, lagers pâles', ions: { 'CALCIUM (CA)': 7, 'MAGNESIUM (MG)': 2, 'SODIUM (NA)': 2, 'SULFATES (SO4)': 5, 'CHLORURES': 5, 'HCO3': 15 } },
    munich: { name: 'Munich', description: 'Eau carbonatée — dunkel, bocks, lagers ambrées', ions: { 'CALCIUM (CA)': 75, 'MAGNESIUM (MG)': 18, 'SODIUM (NA)': 2, 'SULFATES (SO4)': 10, 'CHLORURES': 2, 'HCO3': 150 } },
    vienne: { name: 'Vienne', description: 'Lagers de Vienne, Märzen', ions: { 'CALCIUM (CA)': 200, 'MAGNESIUM (MG)': 60, 'SODIUM (NA)': 8, 'SULFATES (SO4)': 125, 'CHLORURES': 12, 'HCO3': 120 } },
    dortmund: { name: 'Dortmund', description: 'Lagers export', ions: { 'CALCIUM (CA)': 225, 'MAGNESIUM (MG)': 40, 'SODIUM (NA)': 60, 'SULFATES (SO4)': 120, 'CHLORURES': 60, 'HCO3': 220 } },
    burton: { name: 'Burton-on-Trent', description: 'Très sulfatée — pale ales et IPA anglaises', ions: { 'CALCIUM (CA)': 295, 'MAGNESIUM (MG)': 45, 'SODIUM (NA)': 55, 'SULFATES (SO4)': 725, 'CHLORURES': 25, 'HCO3': 300 } },
    dublin: { name: 'Dublin', description: 'Très carbonatée — stouts, porters', ions: { 'CALCIUM (CA)': 118, 'MAGNESIUM (MG)': 4, 'SODIUM (NA)': 12, 'SULFATES (SO4)': 54, 'CHLORURES': 19, 'HCO3': 319 } },
    londres: { name: 'Londres', description: 'Porters, bitters', ions: { 'CALCIUM (CA)': 52, 'MAGNESIUM (MG)': 32, 'SODIUM (NA)': 86, 'SULFATES (SO4)': 32, 'CHLORURES': 34, 'HCO3': 156 } },
    edimbourg: { name: 'Édimbourg', description: 'Scotch ales', ions: { 'CALCIUM (CA)': 125, 'MAGNESIUM (MG)': 25, 'SODIUM (NA)': 55, 'SULFATES (SO4)': 140, 'CHLORURES': 65, 'HCO3': 225 } },
    houblonne: { name: 'Pale ale / IPA (moderne)', description: 'Houblonné, sec et amer — ratio SO4/Cl élevé', ions: { 'CALCIUM (CA)': 110, 'MAGNESIUM (MG)': 18, 'SODIUM (NA)': 16, 'SULFATES (SO4)': 300, 'CHLORURES': 55, 'HCO3': 40 } },
    equilibre: { name: 'Équilibré', description: 'Polyvalent — blondes, ambrées, saisons', ions: { 'CALCIUM (CA)': 70, 'MAGNESIUM (MG)': 10, 'SODIUM (NA)': 15, 'SULFATES (SO4)': 80, 'CHLORURES': 70, 'HCO3': 50 } },
    neipa: { name: 'NEIPA', description: 'Rond et juteux — ratio SO4/Cl inférieur à 1', ions: { 'CALCIUM (CA)': 100, 'MAGNESIUM (MG)': 15, 'SODIUM (NA)': 15, 'SULFATES (SO4)': 75, 'CHLORURES': 150, 'HCO3': 30 } }
};

// Alcalinité résiduelle (Kolbach) en mg/L CaCO3 : alcalinité − (Ca/3,5 + Mg/7) exprimés en CaCO3
const calculateResidualAlkalinity = (water) => {
    const alkalinity = (water['HCO3'] || 0) * 50 / 61;
    const caHardness = (water['CALCIUM (CA)'] || 0) * 2.497;
    const mgHardness = (water['MAGNESIUM (MG)'] || 0) * 4.118;
    return alkalinity - (caHardness / 3.5 + mgHardness / 7);
};

// Ratio sulfates / chlorures (null si pas de chlorures)
const calculateSulfateChlorideRatio = (water) => {
    const cl = water['CHLORURES'] || 0;
    return cl > 0 ? (water['SULFATES (SO4)'] || 0) / cl : null;
};

// Balance ionique : écart relatif entre cations et anions (meq/L)
const calculateIonBalance = (water) => {
    const cations = (water['CALCIUM (CA)'] || 0) / 20.04 + (water['MAGNESIUM (MG)'] || 0) / 12.15
        + (water['SODIUM (NA)'] || 0) / 22.99 + (water['POTASSIUM (K)'] || 0) / 39.10;
    const anions = (water['HCO3'] || 0) / 61.02 + (water['SULFATES (SO4)'] || 0) / 48.03
        + (water['CHLORURES'] || 0) / 35.45;
    if (cations + anions === 0) return null;
    return { cations, anions, error: Math.abs(cations - anions) / (cations + anions) * 100 };
};

// Interprétations (classes Tailwind complètes pour la compilation)
const describeResidualAlkalinity = (ra) => {
    if (ra <= 0) return { text: 'Idéale pour les bières pâles', color: 'text-sky-400' };
    if (ra <= 60) return { text: 'Adaptée aux bières ambrées', color: 'text-amber-400' };
    return { text: 'Adaptée aux bières brunes et stouts', color: 'text-orange-400' };
};

const describeSulfateChlorideRatio = (ratio, water = null) => {
    if (ratio === null) return { text: 'Chlorures non mesurés', color: 'text-slate-400' };
    if (water && (water['SULFATES (SO4)'] || 0) < LOW_SULFATE_CHLORIDE && (water['CHLORURES'] || 0) < LOW_SULFATE_CHLORIDE) {
        return { text: 'Peu significatif : sulfates et chlorures faibles', color: 'text-slate-400', icon: 'fa-circle-minus' };
    }
    if (ratio < 0.5) return { text: 'Très malté', color: 'text-amber-400' };
    if (ratio < 0.8) return { text: 'Malté', color: 'text-amber-400' };
    if (ratio <= 1.5) return { text: 'Équilibré', color: 'text-emerald-400' };
    if (ratio <= 3) return { text: 'Houblonné', color: 'text-lime-400' };
    return { text: 'Très houblonné, amertume sèche', color: 'text-lime-400' };
};

const describeIonBalance = (balance) => {
    if (!balance) return { text: 'Données insuffisantes', color: 'text-slate-400', icon: 'fa-circle-minus' };
    if (balance.error <= 5) return { text: 'Analyse cohérente', color: 'text-emerald-400', icon: 'fa-circle-check' };
    if (balance.error <= 10) return { text: 'Écart acceptable', color: 'text-amber-400', icon: 'fa-triangle-exclamation' };
    return { text: 'Analyse incomplète (mesures de dates différentes ?)', color: 'text-red-400', icon: 'fa-circle-exclamation' };
};

// Solveur : quantités de sels (g) pour approcher un profil cible.
// Moindres carrés relatifs sous contrainte de positivité (descente par coordonnées).
// Les ajouts ne peuvent qu'augmenter les concentrations : un ion déjà au-dessus de la cible reste au-dessus.
const SOLVER_SALTS = ['calciumSulfate', 'magnesiumSulfate', 'calciumChloride', 'sodiumChloride', 'sodiumBicarbonate'];

const solveMineralAdditions = (baseWater, targetIons, liters) => {
    const ions = PROFILE_IONS;
    const scale = ions.map(ion => Math.max(targetIons[ion], 10));
    // Apport en mg/L par g/L de chaque sel
    const contribution = SOLVER_SALTS.map(salt => ions.map(ion => {
        const element = Object.keys(ION_KEYS).find(k => ION_KEYS[k] === ion);
        return (MINERAL_CONVERSIONS[salt][element] || 0) * 1000;
    }));

    const x = SOLVER_SALTS.map(() => 0);
    const residual = ions.map((ion, i) => ((baseWater[ion] || 0) - targetIons[ion]) / scale[i]);

    for (let iter = 0; iter < 500; iter++) {
        SOLVER_SALTS.forEach((_, j) => {
            let gradient = 0;
            let curvature = 0;
            ions.forEach((_, i) => {
                const a = contribution[j][i] / scale[i];
                gradient += a * residual[i];
                curvature += a * a;
            });
            if (curvature === 0) return;
            const next = Math.max(0, x[j] - gradient / curvature);
            const delta = next - x[j];
            if (delta === 0) return;
            ions.forEach((_, i) => { residual[i] += contribution[j][i] / scale[i] * delta; });
            x[j] = next;
        });
    }

    // Conversion g/L → grammes pour le volume, arrondi au pas des champs (0,1 g)
    const grams = {};
    SOLVER_SALTS.forEach((salt, j) => { grams[salt] = Math.round(x[j] * liters * 10) / 10; });
    return grams;
};

// Calcul du HCO3 à partir du TAC
const calculateHCO3 = (tac) => {
    if (!tac || isNaN(tac)) return null;
    const caco3 = parseFloat(tac) * 10; // Conversion °f en mg/L CaCO3
    return (caco3 * 61) / 50; // Conversion CaCO3 en HCO3
};

// Normaliser et fusionner les analyses Hub'Eau et SISE-Eaux.
// Un même prélèvement (code_prelevement identique dans les deux sources) n'est gardé qu'une fois,
// en privilégiant SISE-Eaux ; on obtient ainsi l'historique long de Hub'Eau et les valeurs récentes de SISE.
const mergeAnalyses = (sources) => {
    const merged = new Map();
    sources.forEach(({ data, source }) => {
        if (!data || !Array.isArray(data.data)) return;
        data.data.forEach(item => {
            const value = parseFloat(item.resultat_numerique);
            const date = luxon.DateTime.fromISO(item.date_prelevement || '');
            if (!Number.isFinite(value) || !date.isValid) return;

            const codeParametre = String(item.code_parametre);
            const key = item.code_prelevement
                ? `${item.code_prelevement}|${codeParametre}`
                : `${date.toISODate()}|${codeParametre}|${value}`;
            if (merged.has(key)) return;

            merged.set(key, { code_parametre: codeParametre, value, date, source });
        });
    });
    return Array.from(merged.values());
};

// Source virtuelle pour le HCO3 calculé depuis le TAC
const CALCULATED_SOURCE = { id: 'calcul', name: 'Calculé (TAC)', icon: 'fas fa-calculator', color: 'amber' };

// Statistiques sur les 12 mois précédant la dernière mesure
const computeYearStats = (analyses) => {
    const since = analyses[0].date.minus({ months: 12 });
    const values = analyses.filter(a => a.date >= since).map(a => a.value);
    return {
        n: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((sum, v) => sum + v, 0) / values.length
    };
};

// Calculer l'ancienneté des données et retourner un indicateur
const getDataFreshnessInfo = (latestDate) => {
    if (!latestDate) return null;
    const now = luxon.DateTime.now();
    const diff = now.diff(latestDate, ['months', 'days']);
    const months = Math.floor(diff.months);
    const days = Math.floor(diff.days);

    if (months >= 6) {
        return { level: 'old', color: 'red', icon: 'fas fa-exclamation-triangle', text: `Données anciennes (${months} mois)` };
    } else if (months >= 3) {
        return { level: 'aging', color: 'amber', icon: 'fas fa-exclamation-circle', text: `Données de ${months} mois` };
    } else if (months >= 1) {
        return { level: 'recent', color: 'sky', icon: 'fas fa-info-circle', text: `Données de ${months} mois` };
    }
    return { level: 'fresh', color: 'emerald', icon: 'fas fa-check-circle', text: `Données récentes (${days}j)` };
};

// Regrouper les analyses par paramètre (de la plus récente à la plus ancienne)
// et déterminer le libellé affiché de chaque paramètre
const buildParameterGroups = (analyses) => {
    const parameterGroups = groupByParameter(analyses, PARAMETERS_OF_INTEREST);

    // HCO3 : mesuré (code 1327) environ une fois par an, complété par le calcul depuis le TAC (mensuel)
    // pour les jours sans mesure directe
    const measuredHco3Days = new Set(parameterGroups['HCO3'].map(a => a.date.toISODate()));
    const computedHco3 = parameterGroups['TAC']
        .filter(a => !measuredHco3Days.has(a.date.toISODate()))
        .map(a => ({ ...a, value: calculateHCO3(a.value), source: CALCULATED_SOURCE }));
    parameterGroups['HCO3'] = [...parameterGroups['HCO3'], ...computedHco3].sort((a, b) => b.date - a.date);

    // Libellé affiché pour chaque paramètre
    const labels = {};
    Object.entries(PARAMETERS_OF_INTEREST).forEach(([name, info]) => { labels[name] = info.label; });
    if (computedHco3.length > 0) {
        labels['HCO3'] = measuredHco3Days.size > 0 ? 'Bicarbonates (mesurés + calculés)' : 'Bicarbonates (calculés)';
    }

    return { parameterGroups, labels };
};

// Paramètres de qualité utiles au brasseur (alertes, sans graphique)
const QUALITY_PARAMETERS = {
    'CHLORE LIBRE': { code: '1398', unit: 'mg/L Cl₂' },
    'CHLORE TOTAL': { code: '1399', unit: 'mg/L Cl₂' },
    'NITRATES': { code: '1340', unit: 'mg/L' },
    'FER': { code: '1393', unit: 'µg/L' },
    'MANGANESE': { code: '1394', unit: 'µg/L' }
};

// Formater une valeur numérique à la française (2 décimales max)
const formatValue = (value) => value.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

// Regrouper les analyses par paramètre d'une table (de la plus récente à la plus ancienne)
const groupByParameter = (analyses, parameters) => {
    const groups = {};
    Object.entries(parameters).forEach(([name, info]) => {
        groups[name] = analyses
            .filter(a => a.code_parametre === info.code)
            .sort((a, b) => b.date - a.date);
    });
    return groups;
};

// Niveaux d'alerte → couleur (classes Tailwind complètes pour la compilation)
const QUALITY_LEVEL_COLORS = { ok: 'text-emerald-400', vigilance: 'text-amber-400', alerte: 'text-red-400' };

// Seuil au-dessus duquel le chlore est considéré présent (mg/L Cl2)
const CHLORINE_THRESHOLD = 0.05;

// Évaluer la qualité de l'eau pour le brassage à partir des dernières mesures.
// Un paramètre jamais mesuré n'apparaît pas (pas de faux « OK »).
const assessWaterQuality = (qualityGroups) => {
    const latest = (name) => (qualityGroups[name] && qualityGroups[name][0]) || null;
    const items = [];

    // Chlore : libre et total regroupés ; un écart total − libre signale des chloramines
    const free = latest('CHLORE LIBRE');
    const total = latest('CHLORE TOTAL');
    if (free || total) {
        const reference = total || free;
        const display = [free && `libre ${formatValue(free.value)}`, total && `total ${formatValue(total.value)}`]
            .filter(Boolean).join(' / ') + ' mg/L';
        let level = 'ok';
        let message = 'Chlore non détecté : aucun traitement nécessaire.';
        if (reference.value >= CHLORINE_THRESHOLD) {
            level = 'vigilance';
            const combined = free && total ? total.value - free.value : 0;
            message = combined >= 0.1
                ? `Chloramines probables (chlore combiné ${formatValue(Math.round(combined * 100) / 100)} mg/L) : l'ébullition ou le dégazage ne suffisent pas. 1 comprimé de Campden (métabisulfite) pour ~75 L, quelques minutes avant usage.`
                : 'Risque de chlorophénols (goût médicamenteux) : 1 comprimé de Campden (métabisulfite) pour ~75 L, ou dégazage une nuit à l\'air libre.';
        }
        items.push({ title: 'Chlore', display, date: reference.date, level, message });
    }

    // Paramètres à seuils simples : [nom, titre, seuil vigilance, seuil alerte, messages]
    const thresholds = [
        ['NITRATES', 'Nitrates', 25, 50, {
            ok: 'Teneur faible.',
            vigilance: 'Teneur élevée (> 25 mg/L), à surveiller.',
            alerte: 'Dépasse la limite de potabilité (50 mg/L) : utilisez une autre eau.'
        }],
        ['FER', 'Fer', 100, 200, {
            ok: 'Pas d\'impact attendu.',
            vigilance: 'Peut donner un goût métallique.',
            alerte: 'Goût métallique et trouble possibles, gêne la levure : filtrez ou utilisez une autre eau.'
        }],
        ['MANGANESE', 'Manganèse', 20, 50, {
            ok: 'Pas d\'impact attendu.',
            vigilance: 'Peut donner un goût métallique.',
            alerte: 'Dépasse la référence de qualité (50 µg/L) : goût métallique probable.'
        }]
    ];
    thresholds.forEach(([name, title, warn, alert, messages]) => {
        const measure = latest(name);
        if (!measure) return;
        const level = measure.value > alert ? 'alerte' : measure.value > warn ? 'vigilance' : 'ok';
        items.push({
            title,
            display: `${formatValue(measure.value)} ${QUALITY_PARAMETERS[name].unit}`,
            date: measure.date,
            level,
            message: messages[level]
        });
    });

    return items;
};

// Dureté totale (TH) en °f : (Ca × 2,497 + Mg × 4,118) mg/L CaCO3 / 10
const calculateTotalHardness = (water) =>
    ((water['CALCIUM (CA)'] || 0) * 2.497 + (water['MAGNESIUM (MG)'] || 0) * 4.118) / 10;

// Classes de dureté usuelles en France (°f)
const describeHardness = (th) => {
    if (th < 7) return { text: 'Très douce', color: 'text-sky-400' };
    if (th < 15) return { text: 'Douce', color: 'text-sky-400' };
    if (th < 30) return { text: 'Moyennement dure', color: 'text-amber-400' };
    if (th < 40) return { text: 'Dure', color: 'text-orange-400' };
    return { text: 'Très dure', color: 'text-orange-400' };
};

// En dessous de ce seuil (mg/L), sulfates et chlorures sont trop faibles pour orienter le goût
const LOW_SULFATE_CHLORIDE = 20;

// Synthèse en langage courant : une phrase principale et des précisions
const summarizeWater = (water, qualityItems = []) => {
    const th = calculateTotalHardness(water);
    const ra = calculateResidualAlkalinity(water);
    const hardness = describeHardness(th).text.toLowerCase();
    const headline = `Eau ${hardness} (dureté ${formatValue(Math.round(th * 10) / 10)} °f)`
        + (ra <= 0 ? ', idéale telle quelle pour les bières pâles.'
            : ra <= 60 ? ', adaptée aux bières ambrées.'
                : ', adaptée aux bières brunes et aux stouts.');

    const details = [];
    if (th < 15) {
        details.push('Peu minéralisée : une bonne base pour construire n\'importe quel profil avec des sels.');
    }
    if (ra > 0) {
        details.push('Pour une bière pâle, acidifiez la maische ou diluez avec de l\'eau osmosée.');
    }
    const sulfate = water['SULFATES (SO4)'] || 0;
    const chloride = water['CHLORURES'] || 0;
    if (sulfate >= LOW_SULFATE_CHLORIDE || chloride >= LOW_SULFATE_CHLORIDE) {
        const ratio = calculateSulfateChlorideRatio(water);
        if (ratio !== null) details.push(`Ratio sulfates/chlorures : profil ${describeSulfateChlorideRatio(ratio).text.toLowerCase()}.`);
    }
    // Action prioritaire : alerte d'abord, puis vigilance
    const priority = qualityItems.find(i => i.level === 'alerte') || qualityItems.find(i => i.level === 'vigilance');
    if (priority) {
        details.push(priority.title === 'Chlore'
            ? 'Chlore présent : traitez l\'eau au Campden avant de brasser.'
            : `${priority.title} : ${priority.message}`);
    }
    return { headline, details };
};

// Échelle de la jauge d'un paramètre : couvre le repère brassage, l'étendue sur 12 mois et la dernière valeur
const gaugeScale = (name, values) => {
    const info = PARAMETERS_OF_INTEREST[name];
    if (info.scale) return info.scale;
    const highest = Math.max(...values, info.range ? info.range.max : 0);
    return { min: 0, max: highest * 1.15 || 1 };
};

// Position (en %) d'une valeur sur une échelle, bornée à [0, 100]
const gaugePosition = (value, scale) => {
    const span = scale.max - scale.min;
    if (!(span > 0)) return 0;
    return Math.min(100, Math.max(0, (value - scale.min) / span * 100));
};

// Textes d'aide (bulles « ? »)
const HELP_TEXTS = {
    durete: 'Somme du calcium et du magnésium, en degrés français (°f). Une eau douce se corrige facilement par ajout de sels ; une eau dure se dilue à l\'eau osmosée.',
    alcalinite: 'Capacité de l\'eau à faire remonter le pH de la maische, une fois compensée par le calcium et le magnésium. Négative ou nulle : bières pâles. Élevée : bières foncées, dont les malts torréfiés acidifient la maische.',
    ratio: 'Rapport sulfates / chlorures. Les sulfates accentuent l\'amertume sèche, les chlorures la rondeur maltée. Peu significatif quand les deux sont faibles (moins de 20 mg/L).',
    balance: 'Écart entre cations et anions mesurés. Un écart important signale des mesures prises à des dates différentes ou un ion non mesuré : interprétez les valeurs avec prudence.',
    chlore: 'Le chlore et les chloramines forment des chlorophénols (goût médicamenteux). Un comprimé de Campden (métabisulfite) pour ~75 L les neutralise en quelques minutes ; le chlore libre part aussi par dégazage une nuit, pas les chloramines.'
};

// Périodes de l'historique, comptées depuis la dernière mesure
const HISTORY_PERIODS = {
    '1an': { label: '1 an', months: 12 },
    '3ans': { label: '3 ans', months: 36 },
    'tout': { label: 'Tout', months: null }
};

// Mesures d'une période, en ordre chronologique (pour le graphique)
const filterByPeriod = (analyses, period) => {
    if (analyses.length === 0) return [];
    const latest = analyses.reduce((max, a) => (a.date > max ? a.date : max), analyses[0].date);
    const months = (HISTORY_PERIODS[period] || HISTORY_PERIODS.tout).months;
    const since = months ? latest.minus({ months }) : null;
    return analyses
        .filter(a => !since || a.date >= since)
        .sort((a, b) => a.date - b.date);
};

// Écart à la cible d'un profil : « ok » à 15 % près (10 mg/L au moins), « proche » jusqu'au triple, sinon « loin »
const profileDeviation = (value, target) => {
    const tolerance = Math.max(target * 0.15, 10);
    const delta = Math.abs(value - target);
    if (delta <= tolerance) return 'ok';
    if (delta <= tolerance * 3) return 'proche';
    return 'loin';
};

// Modes d'eau de base du calculateur
const BASE_WATER_MODES = {
    derniere: 'Dernière mesure',
    moyenne: 'Moyenne 12 mois',
    maximum: 'Maximum 12 mois'
};

// Eaux de base possibles : dernière mesure, moyenne et maximum sur les 12 mois précédant la dernière mesure
const buildBaseWaters = (parameterGroups) => {
    const waters = { derniere: {}, moyenne: {}, maximum: {} };
    Object.keys(PARAMETERS_OF_INTEREST).forEach(name => {
        const analyses = parameterGroups[name] || [];
        if (analyses.length === 0) {
            waters.derniere[name] = waters.moyenne[name] = waters.maximum[name] = 0;
            return;
        }
        const stats = computeYearStats(analyses);
        waters.derniere[name] = analyses[0].value;
        waters.moyenne[name] = stats.avg;
        waters.maximum[name] = stats.max;
    });
    return waters;
};

// Échapper un texte pour XML
const escapeXml = (text) => String(text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[c]);

// Correspondance champs BeerXML 1.0 (<WATER>, en ppm) → paramètres
const BEERXML_FIELDS = {
    CALCIUM: 'CALCIUM (CA)',
    BICARBONATE: 'HCO3',
    SULFATE: 'SULFATES (SO4)',
    CHLORIDE: 'CHLORURES',
    SODIUM: 'SODIUM (NA)',
    MAGNESIUM: 'MAGNESIUM (MG)'
};

// Exporter des eaux au format BeerXML : [{ name, liters, water, notes }]
const toBeerXmlWaters = (entries) => {
    const round = (value) => Math.round((value || 0) * 10) / 10;
    const records = entries.map(({ name, liters, water, notes }) => {
        const lines = [
            `<NAME>${escapeXml(name)}</NAME>`,
            '<VERSION>1</VERSION>',
            `<AMOUNT>${round(liters)}</AMOUNT>`,
            ...Object.entries(BEERXML_FIELDS).map(([field, key]) => `<${field}>${round(water[key])}</${field}>`)
        ];
        if (water['PH'] > 0) lines.push(`<PH>${round(water['PH'])}</PH>`);
        if (notes) lines.push(`<NOTES>${escapeXml(notes)}</NOTES>`);
        return `  <WATER>\n${lines.map(l => '    ' + l).join('\n')}\n  </WATER>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<WATERS>\n${records.join('\n')}\n</WATERS>\n`;
};


// Export pour les tests Node (sans effet dans le navigateur)
if (typeof module !== 'undefined') {
    module.exports = {
        SELECTION_PATTERNS,
        sanitizeSelection,
        DATA_SOURCES,
        PARAMETERS_OF_INTEREST,
        MINERAL_CONVERSIONS,
        ION_KEYS,
        calculateMineralAdditions,
        PROFILE_IONS,
        WATER_PROFILES,
        calculateResidualAlkalinity,
        calculateSulfateChlorideRatio,
        calculateIonBalance,
        describeResidualAlkalinity,
        describeSulfateChlorideRatio,
        describeIonBalance,
        SOLVER_SALTS,
        solveMineralAdditions,
        calculateHCO3,
        mergeAnalyses,
        CALCULATED_SOURCE,
        computeYearStats,
        getDataFreshnessInfo,
        buildParameterGroups,
        QUALITY_PARAMETERS,
        formatValue,
        groupByParameter,
        QUALITY_LEVEL_COLORS,
        assessWaterQuality,
        BASE_WATER_MODES,
        buildBaseWaters,
        escapeXml,
        toBeerXmlWaters,
        calculateTotalHardness,
        describeHardness,
        LOW_SULFATE_CHLORIDE,
        summarizeWater,
        gaugeScale,
        gaugePosition,
        HELP_TEXTS,
        HISTORY_PERIODS,
        filterByPeriod,
        profileDeviation
    };
}
