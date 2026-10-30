// Fonction de debug — no-op en production, activable via ?debug=1
const DEBUG_ENABLED = new URLSearchParams(window.location.search).has('debug');
function debug(message) {
    if (DEBUG_ENABLED) console.log(message);
}

// Sélection courante (département, commune, réseau) : reflétée dans l'URL et mémorisée localement
const SELECTION_STORAGE_KEY = 'eau-brasseur:selection';
const SELECTION_PATTERNS = { dept: /^[0-9AB]{2,3}$/i, commune: /^[0-9AB]{5}$/i, reseau: /^[0-9AB]{9}$/i };

// Garder uniquement les codes au format attendu
const sanitizeSelection = (selection) => {
    const clean = {};
    Object.entries(SELECTION_PATTERNS).forEach(([key, pattern]) => {
        if (typeof selection[key] === 'string' && pattern.test(selection[key])) clean[key] = selection[key];
    });
    return clean;
};

const saveSelection = (selection) => {
    const clean = sanitizeSelection(selection);
    const url = new URL(window.location.href);
    Object.keys(SELECTION_PATTERNS).forEach(key => {
        if (clean[key]) url.searchParams.set(key, clean[key]);
        else url.searchParams.delete(key);
    });
    window.history.replaceState(null, '', url);
    try {
        localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(clean));
    } catch {
        // Stockage indisponible (navigation privée...) : le lien reste partageable
    }
};

// Sélection à restaurer : paramètres d'URL (lien partagé) sinon dernière sélection locale
const readSelection = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('dept')) {
        return sanitizeSelection(Object.fromEntries(params));
    }
    try {
        return sanitizeSelection(JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY)) || {});
    } catch {
        return {};
    }
};

// Rejouer la sélection : département → commune → réseau
const restoreSelection = async () => {
    const selection = readSelection();
    const departementSelect = document.getElementById('departementSelect');
    const communeSelect = document.getElementById('communeSelect');
    const hasOption = (select, value) => Array.from(select.options).some(o => o.value === value);

    if (!selection.dept || !hasOption(departementSelect, selection.dept)) return;
    departementSelect.value = selection.dept;
    await loadCommunes(selection.dept);

    if (!selection.commune || !hasOption(communeSelect, selection.commune)) return;
    communeSelect.value = selection.commune;
    await loadAnalyses(selection.commune);

    if (!selection.reseau) return;
    const button = Array.from(document.querySelectorAll('#networkButtons button'))
        .find(btn => btn.dataset.networkCode === selection.reseau);
    if (button) button.click();
};

// Fonction principale de l'application (script chargé en defer : le DOM est prêt)
function initApp() {
    const departementSelect = document.getElementById('departementSelect');
    const communeSelect = document.getElementById('communeSelect');

    departementSelect.addEventListener('change', (e) => {
        saveSelection({ dept: e.target.value });
        loadCommunes(e.target.value);
        hideResults();
    });

    communeSelect.addEventListener('change', (e) => {
        saveSelection({ dept: departementSelect.value, commune: e.target.value });
        if (e.target.value) {
            loadAnalyses(e.target.value);
        }
        hideResults();
    });

    loadDepartements().then(restoreSelection);
}

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
const PARAMETERS_OF_INTEREST = {
    'CALCIUM (CA)': { code: '1374', unit: 'mg/L', target: { min: 50, max: 150 } },
    'MAGNESIUM (MG)': { code: '1372', unit: 'mg/L', target: { min: 10, max: 30 } },
    'SODIUM (NA)': { code: '1375', unit: 'mg/L', target: { min: 0, max: 150 } },
    'SULFATES (SO4)': { code: '1338', unit: 'mg/L', target: { min: 50, max: 350 } },
    'CHLORURES': { code: '1337', unit: 'mg/L', target: { min: 0, max: 250 } },
    'POTASSIUM (K)': { code: '1367', unit: 'mg/L', target: { min: 0, max: 10 } },
    'PH': { code: '1302', unit: 'unité pH', target: { min: 6.5, max: 9 } },
    'TAC': { code: '1347', unit: '°f', target: { min: 0, max: 40 } },
    'HCO3': { code: '1327', unit: 'mg/L', target: { min: 0, max: 400 } }
};

// Couleurs pour les différents paramètres
const PARAMETER_COLORS = {
    'CALCIUM (CA)': { color: 'rgb(59, 130, 246)', background: 'rgba(59, 130, 246, 0.1)' }, // Bleu
    'MAGNESIUM (MG)': { color: 'rgb(16, 185, 129)', background: 'rgba(16, 185, 129, 0.1)' }, // Vert
    'SODIUM (NA)': { color: 'rgb(245, 158, 11)', background: 'rgba(245, 158, 11, 0.1)' }, // Orange
    'SULFATES (SO4)': { color: 'rgb(139, 92, 246)', background: 'rgba(139, 92, 246, 0.1)' }, // Violet
    'CHLORURES': { color: 'rgb(239, 68, 68)', background: 'rgba(239, 68, 68, 0.1)' }, // Rouge
    'POTASSIUM (K)': { color: 'rgb(236, 72, 153)', background: 'rgba(236, 72, 153, 0.1)' }, // Rose
    'PH': { color: 'rgb(79, 70, 229)', background: 'rgba(79, 70, 229, 0.1)' }, // Indigo
    'TAC': { color: 'rgb(107, 114, 128)', background: 'rgba(107, 114, 128, 0.1)' }, // Gris
    'HCO3': { color: 'rgb(75, 85, 99)', background: 'rgba(75, 85, 99, 0.1)' } // Gris foncé
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

const describeSulfateChlorideRatio = (ratio) => {
    if (ratio === null) return { text: 'Chlorures non mesurés', color: 'text-slate-400' };
    if (ratio < 0.5) return { text: 'Très malté', color: 'text-amber-400' };
    if (ratio < 0.8) return { text: 'Malté', color: 'text-amber-400' };
    if (ratio <= 1.5) return { text: 'Équilibré', color: 'text-emerald-400' };
    if (ratio <= 3) return { text: 'Houblonné', color: 'text-lime-400' };
    return { text: 'Très houblonné, amertume sèche', color: 'text-lime-400' };
};

const describeIonBalance = (balance) => {
    if (!balance) return { text: 'Données insuffisantes', color: 'text-slate-400' };
    if (balance.error <= 5) return { text: 'Analyse cohérente', color: 'text-emerald-400' };
    if (balance.error <= 10) return { text: 'Écart acceptable', color: 'text-amber-400' };
    return { text: 'Analyse incomplète (mesures de dates différentes ?)', color: 'text-red-400' };
};

// Créer une tuile d'indicateur
const createIndicatorTile = (title, value, interpretation) => {
    const tile = document.createElement('div');
    tile.className = 'p-4 rounded-xl bg-slate-800/40 border border-slate-700/50';
    const titleEl = document.createElement('p');
    titleEl.className = 'text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2';
    titleEl.textContent = title;
    const valueEl = document.createElement('p');
    valueEl.className = 'text-2xl font-bold text-white';
    valueEl.textContent = value;
    const hintEl = document.createElement('p');
    hintEl.className = `text-xs mt-1 ${interpretation.color}`;
    hintEl.textContent = interpretation.text;
    tile.append(titleEl, valueEl, hintEl);
    return tile;
};

// Afficher les indicateurs brassicoles d'une eau dans un conteneur
const renderBrewingIndicators = (container, water) => {
    if (!container) return;
    container.innerHTML = '';

    const ra = calculateResidualAlkalinity(water);
    container.appendChild(createIndicatorTile(
        'Alcalinité résiduelle',
        `${formatValue(Math.round(ra))} mg/L CaCO₃ (${formatValue(Math.round(ra / 10 * 10) / 10)} °f)`,
        describeResidualAlkalinity(ra)
    ));

    const ratio = calculateSulfateChlorideRatio(water);
    container.appendChild(createIndicatorTile(
        'Ratio SO₄ / Cl',
        ratio === null ? '—' : formatValue(Math.round(ratio * 100) / 100),
        describeSulfateChlorideRatio(ratio)
    ));

    const balance = calculateIonBalance(water);
    container.appendChild(createIndicatorTile(
        'Balance ionique',
        balance ? `${formatValue(Math.round(balance.error * 10) / 10)} %` : '—',
        describeIonBalance(balance)
    ));
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

// Eau de base courante du calculateur (mise à jour à chaque sélection de réseau)
let calculatorBaseWater = null;
let calculatorInitialized = false;

// IDs des inputs de minéraux du calculateur
const MINERAL_INPUT_IDS = [
    'calciumSulfate',
    'magnesiumSulfate',
    'calciumChloride',
    'sodiumChloride',
    'calciumCarbonate',
    'sodiumBicarbonate',
    'potassiumChloride'
];

// Créer l'affichage d'une valeur avec indicateur de plage (sécurisé contre XSS)
const createParameterDisplay = (value, unit, target) => {
    const isInRange = value >= target.min && value <= target.max;
    const span = document.createElement('span');
    span.className = isInRange ? 'text-green-600' : 'text-red-600';
    span.textContent = `${value.toFixed(1)} ${unit}`;
    return span;
};

// Afficher les paramètres d'une eau dans un conteneur (sécurisé contre XSS - pas de innerHTML)
const displayCalculatorParameters = (container, water) => {
    if (!container) return;
    container.innerHTML = '';
    Object.entries(PARAMETERS_OF_INTEREST)
        .filter(([name]) => name !== 'TAC' && name !== 'PH')
        .forEach(([name, info]) => {
            const value = water[name] || 0;
            const row = document.createElement('div');
            row.className = 'flex justify-between items-center p-3 rounded-lg bg-slate-700/30 border border-slate-600/30';
            const label = document.createElement('span');
            label.className = 'font-medium text-slate-300';
            label.textContent = `${name}:`;
            row.appendChild(label);
            row.appendChild(createParameterDisplay(value, info.unit, info.target));
            container.appendChild(row);
        });
};

// Recalculer et afficher l'eau modifiée à partir des saisies
const updateCalculations = () => {
    if (!calculatorBaseWater) return;
    const waterQuantity = document.getElementById('waterQuantity').value;
    const additions = {};
    MINERAL_INPUT_IDS.forEach(id => {
        additions[id] = parseFloat(document.getElementById(id).value) || 0;
    });

    const modifiedWater = calculateMineralAdditions(calculatorBaseWater, additions, waterQuantity);
    displayCalculatorParameters(document.getElementById('modifiedWaterParams'), modifiedWater);
    renderBrewingIndicators(document.getElementById('modifiedIndicators'), modifiedWater);
    renderProfileComparison(modifiedWater);
};

// Profil cible sélectionné (ou null)
const getSelectedProfile = () => {
    const select = document.getElementById('targetProfile');
    return select ? WATER_PROFILES[select.value] || null : null;
};

// Message du solveur (ions impossibles à atteindre par ajout)
let solverNote = '';

// Tableau de comparaison eau modifiée / profil cible (sécurisé contre XSS)
const renderProfileComparison = (water) => {
    const container = document.getElementById('profileTable');
    if (!container) return;
    container.innerHTML = '';

    const profile = getSelectedProfile();
    if (!profile) {
        const hint = document.createElement('p');
        hint.className = 'text-sm text-slate-500';
        hint.textContent = 'Choisissez un profil cible pour comparer votre eau et obtenir une suggestion d\'ajouts.';
        container.appendChild(hint);
        return;
    }

    const table = document.createElement('table');
    table.className = 'w-full text-sm';
    const head = document.createElement('tr');
    head.className = 'text-left text-xs text-slate-400 uppercase tracking-wide';
    ['Paramètre', 'Eau modifiée', `Cible ${profile.name}`, 'Écart'].forEach(text => {
        const th = document.createElement('th');
        th.className = 'pb-3 font-semibold';
        th.textContent = text;
        head.appendChild(th);
    });
    table.appendChild(head);

    PROFILE_IONS.forEach(ion => {
        const value = water[ion] || 0;
        const target = profile.ions[ion];
        const delta = value - target;
        // Tolérance : 15 % de la cible, au moins 10 mg/L
        const tolerance = Math.max(target * 0.15, 10);
        const deltaColor = Math.abs(delta) <= tolerance ? 'text-emerald-400'
            : Math.abs(delta) <= tolerance * 3 ? 'text-amber-400' : 'text-red-400';

        const row = document.createElement('tr');
        row.className = 'border-t border-slate-700/50';
        [
            { text: ion, className: 'py-2 text-slate-300' },
            { text: `${formatValue(Math.round(value * 10) / 10)} mg/L`, className: 'py-2 text-white font-mono' },
            { text: `${formatValue(target)} mg/L`, className: 'py-2 text-slate-400 font-mono' },
            { text: `${delta > 0 ? '+' : ''}${formatValue(Math.round(delta * 10) / 10)}`, className: `py-2 font-mono ${deltaColor}` }
        ].forEach(cell => {
            const td = document.createElement('td');
            td.className = cell.className;
            td.textContent = cell.text;
            row.appendChild(td);
        });
        table.appendChild(row);
    });
    container.appendChild(table);

    if (solverNote) {
        const note = document.createElement('p');
        note.className = 'mt-4 text-xs text-amber-400';
        note.textContent = solverNote;
        container.appendChild(note);
    }
};

// Remplir les champs avec les ajouts suggérés pour le profil sélectionné
const applySuggestedAdditions = () => {
    const profile = getSelectedProfile();
    const liters = parseFloat(document.getElementById('waterQuantity').value);
    if (!profile || !calculatorBaseWater || !(liters > 0)) return;

    const grams = solveMineralAdditions(calculatorBaseWater, profile.ions, liters);
    MINERAL_INPUT_IDS.forEach(id => {
        document.getElementById(id).value = grams[id] || 0;
    });

    // Signaler les ions que les ajouts ne peuvent pas faire baisser
    const result = calculateMineralAdditions(calculatorBaseWater, grams, liters);
    const tooHigh = PROFILE_IONS.filter(ion => result[ion] > Math.max(profile.ions[ion] * 1.15, profile.ions[ion] + 10));
    solverNote = tooHigh.length > 0
        ? `Au-dessus de la cible : ${tooHigh.join(', ')}. Les ajouts ne peuvent pas réduire ces ions — diluez avec de l'eau osmosée ou déminéralisée.`
        : '';

    updateCalculations();
};

// Rafraîchir l'affichage complet du calculateur (eau de base + eau modifiée)
const renderCalculator = () => {
    if (!calculatorBaseWater) return;
    displayCalculatorParameters(document.getElementById('baseWaterParams'), calculatorBaseWater);
    updateCalculations();
};

// Attacher les écouteurs du calculateur une seule fois
function initializeCalculator() {
    if (calculatorInitialized) return;
    const waterCalculator = document.getElementById('waterCalculator');
    const openCalculatorBtn = document.getElementById('openCalculator');
    if (!waterCalculator || !openCalculatorBtn) return;

    openCalculatorBtn.addEventListener('click', () => {
        waterCalculator.classList.toggle('hidden');
        if (!waterCalculator.classList.contains('hidden')) {
            renderCalculator();
        }
    });

    // Profils cibles
    const profileSelect = document.getElementById('targetProfile');
    const suggestButton = document.getElementById('suggestAdditions');
    const profileDescription = document.getElementById('profileDescription');
    if (profileSelect) {
        Object.entries(WATER_PROFILES).forEach(([id, profile]) => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = profile.name;
            profileSelect.appendChild(option);
        });
        profileSelect.addEventListener('change', () => {
            const profile = getSelectedProfile();
            if (suggestButton) suggestButton.disabled = !profile;
            if (profileDescription) {
                profileDescription.textContent = profile ? `${profile.description} — valeurs indicatives.` : '';
            }
            solverNote = '';
            updateCalculations();
        });
    }
    if (suggestButton) {
        suggestButton.addEventListener('click', applySuggestedAdditions);
    }

    ['waterQuantity', ...MINERAL_INPUT_IDS].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', updateCalculations);
        }
    });

    calculatorInitialized = true;
}

// Mettre à jour l'eau de base du calculateur
function updateCalculator(baseWater) {
    calculatorBaseWater = baseWater;
    initializeCalculator();

    const waterCalculator = document.getElementById('waterCalculator');
    if (waterCalculator) {
        // Cacher le calculateur à chaque nouvelle sélection de réseau
        waterCalculator.classList.add('hidden');
    }
}

// Fonction pour cacher tous les résultats
function hideResults() {
    const elementsToHide = ['networkButtons', 'currentParameters', 'charts', 'waterCalculator'];
    elementsToHide.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.classList.add('hidden');
        }
    });
}

// Calcul du HCO3 à partir du TAC
const calculateHCO3 = (tac) => {
    if (!tac || isNaN(tac)) return null;
    const caco3 = parseFloat(tac) * 10; // Conversion °f en mg/L CaCO3
    return (caco3 * 61) / 50; // Conversion CaCO3 en HCO3
};

// Gestion des états de chargement
const setLoading = (isLoading) => {
    const loadingElement = document.getElementById('loading');
    if (loadingElement) {
        loadingElement.classList.toggle('hidden', !isLoading);
    }
};

const showError = (message) => {
    const errorElement = document.getElementById('error');
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.classList.remove('hidden');
    }
};

const hideError = () => {
    const errorElement = document.getElementById('error');
    if (errorElement) {
        errorElement.classList.add('hidden');
        errorElement.textContent = '';
    }
};

// Chargement des départements
const loadDepartements = async () => {
    try {
        setLoading(true);
        debug('Chargement des départements...');
        const response = await fetch('https://geo.api.gouv.fr/departements', {
            headers: {
                'Accept': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }
        debug('Réponse reçue de l\'API départements');
        const departements = await response.json();
        if (!Array.isArray(departements)) {
            throw new Error('Format de réponse invalide');
        }
        debug(`${departements.length} départements chargés`);

        // Corse : 2A et 2B se placent entre 19 et 21
        const deptSortKey = (code) => parseFloat(code.replace('2A', '20.1').replace('2B', '20.2'));
        departements.sort((a, b) => deptSortKey(a.code) - deptSortKey(b.code));
        departements.forEach(dept => {
            const option = document.createElement('option');
            option.value = dept.code;
            option.textContent = `${dept.code} - ${dept.nom}`;
            const departementSelect = document.getElementById('departementSelect');
            if (departementSelect) {
                departementSelect.appendChild(option);
            }
        });
        debug('Liste des départements mise à jour');
    } catch (error) {
        const errorMsg = 'Erreur lors du chargement des départements: ' + error.message;
        showError(errorMsg);
        debug(errorMsg);
        console.error(error);
    } finally {
        setLoading(false);
    }
};

// Chargement des communes d'un département
const loadCommunes = async (deptCode) => {
    try {
        setLoading(true);
        debug(`Chargement des communes pour le département ${deptCode}...`);
        const communeSelect = document.getElementById('communeSelect');
        if (communeSelect) {
            communeSelect.innerHTML = '<option value="">Sélectionnez une commune...</option>';
            communeSelect.disabled = true;
        }

        if (!deptCode) return;

        const response = await fetch(`https://geo.api.gouv.fr/departements/${encodeURIComponent(deptCode)}/communes`, {
            headers: {
                'Accept': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }
        debug('Réponse reçue de l\'API communes');
        const communes = await response.json();
        if (!Array.isArray(communes)) {
            throw new Error('Format de réponse invalide');
        }
        debug(`${communes.length} communes chargées`);

        communes.sort((a, b) => a.nom.localeCompare(b.nom));
        communes.forEach(commune => {
            const option = document.createElement('option');
            option.value = commune.code;
            option.textContent = commune.nom;
            if (communeSelect) {
                communeSelect.appendChild(option);
            }
        });

        if (communeSelect) {
            communeSelect.disabled = false;
        }
        debug('Liste des communes mise à jour');
    } catch (error) {
        const errorMsg = 'Erreur lors du chargement des communes: ' + error.message;
        showError(errorMsg);
        debug(errorMsg);
        console.error(error);
    } finally {
        setLoading(false);
    }
};

// Vérifier si le backend SISE-Eaux est disponible
let siseAvailable = null;
let siseLastCheck = 0;
const SISE_CHECK_INTERVAL = 30000; // Re-vérifier toutes les 30s si indisponible
const checkSiseBackend = async () => {
    const now = Date.now();
    // Retourner le cache si disponible et récent
    if (siseAvailable === true) return true;
    if (siseAvailable === false && (now - siseLastCheck) < SISE_CHECK_INTERVAL) return false;

    siseLastCheck = now;
    try {
        const response = await fetch('/api/sise/health', { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
            const health = await response.json();
            siseAvailable = health.status === 'ok' && health.record_count > 0;
            if (siseAvailable) {
                debug(`Backend SISE-Eaux disponible — ${health.record_count} résultats, dernière sync: ${health.last_sync}`);
            } else {
                debug('Backend SISE-Eaux pas encore prêt: ' + JSON.stringify(health));
            }
        } else {
            siseAvailable = false;
            debug('Backend SISE-Eaux HTTP ' + response.status);
        }
    } catch (e) {
        siseAvailable = false;
        debug('Backend SISE-Eaux indisponible: ' + e.message);
    }
    return siseAvailable;
};

// Requêter le backend SISE-Eaux pour les réseaux d'une commune
const fetchSiseNetworks = async (communeCode) => {
    const response = await fetch(`/api/sise/communes_udi?code_commune=${encodeURIComponent(communeCode)}`);
    if (!response.ok) throw new Error(`SISE HTTP ${response.status}`);
    return response.json();
};

// Requêter le backend SISE-Eaux pour les analyses d'un réseau
const fetchSiseAnalyses = async (networkCode, paramCodes) => {
    const response = await fetch(`/api/sise/resultats?code_reseau=${encodeURIComponent(networkCode)}&code_parametre=${encodeURIComponent(paramCodes)}`);
    if (!response.ok) throw new Error(`SISE HTTP ${response.status}`);
    return response.json();
};

// Requêter Hub'Eau pour les réseaux d'une commune
const fetchHubEauNetworks = async (communeCode) => {
    const response = await fetch(`https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/communes_udi?code_commune=${encodeURIComponent(communeCode)}&size=100`, {
        headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`Hub'Eau HTTP ${response.status}`);
    return response.json();
};

// Requêter Hub'Eau pour les analyses d'un réseau
const fetchHubEauAnalyses = async (networkCode, paramCodes) => {
    const response = await fetch(`https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_reseau=${encodeURIComponent(networkCode)}&code_parametre=${encodeURIComponent(paramCodes)}&size=5000`, {
        headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`Hub'Eau HTTP ${response.status}`);
    return response.json();
};

// Jeton de la dernière requête : ignore les réponses d'une sélection obsolète
let currentRequestId = 0;

// Chargement des analyses d'eau — interroge Hub'Eau + SISE-Eaux, fusionne les réseaux
const loadAnalyses = async (communeCode) => {
    const requestId = ++currentRequestId;
    try {
        setLoading(true);
        hideError();

        // Lancer les deux requêtes en parallèle
        const hasSise = await checkSiseBackend();
        const promises = [fetchHubEauNetworks(communeCode).catch(() => null)];
        if (hasSise) promises.push(fetchSiseNetworks(communeCode).catch(() => null));

        const [hubEauData, siseData] = await Promise.all(promises);
        if (requestId !== currentRequestId) return;

        // Fusionner les réseaux des deux sources (dédoublonnage par code_reseau)
        const uniqueNetworks = new Map();
        const addNetworks = (data) => {
            if (!data || !Array.isArray(data.data)) return;
            data.data.forEach(item => {
                if (!uniqueNetworks.has(item.code_reseau)) {
                    uniqueNetworks.set(item.code_reseau, {
                        code: item.code_reseau,
                        name: item.nom_reseau
                    });
                }
            });
        };

        addNetworks(hubEauData);
        addNetworks(siseData);

        if (uniqueNetworks.size === 0) {
            showError('Aucune donnée disponible pour cette commune');
            return;
        }

        const networks = Array.from(uniqueNetworks.values())
            .sort((a, b) => a.name.localeCompare(b.name));

        displayNetworks(networks);
    } catch (error) {
        if (requestId !== currentRequestId) return;
        showError('Erreur lors du chargement des réseaux');
        console.error(error);
    } finally {
        if (requestId === currentRequestId) setLoading(false);
    }
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

// Chargement des analyses pour un réseau — fusionne Hub'Eau et SISE-Eaux
const loadNetworkAnalyses = async (networkCode) => {
    const requestId = ++currentRequestId;
    try {
        setLoading(true);
        hideError();

        const paramCodes = Object.values(PARAMETERS_OF_INTEREST).map(p => p.code).join(',');

        // Lancer les deux requêtes en parallèle
        const hasSise = await checkSiseBackend();
        const promises = [fetchHubEauAnalyses(networkCode, paramCodes).catch(() => null)];
        if (hasSise) promises.push(fetchSiseAnalyses(networkCode, paramCodes).catch(() => null));

        const [hubEauData, siseData] = await Promise.all(promises);
        if (requestId !== currentRequestId) return;

        const analyses = mergeAnalyses([
            { data: siseData, source: DATA_SOURCES.SISE_EAUX },
            { data: hubEauData, source: DATA_SOURCES.HUBEAU }
        ]);
        debug(`Analyses fusionnées : ${analyses.length} (Hub'Eau ${hubEauData?.data?.length ?? 0}, SISE ${siseData?.data?.length ?? 0})`);

        if (analyses.length === 0) {
            showError('Aucune analyse disponible pour ce réseau');
            return;
        }

        displayAnalyses(analyses);
    } catch (error) {
        if (requestId !== currentRequestId) return;
        showError('Erreur lors du chargement des analyses');
        console.error(error);
    } finally {
        if (requestId === currentRequestId) setLoading(false);
    }
};

// Affichage des réseaux disponibles
const displayNetworks = (networks) => {
    const container = document.getElementById('networkButtons');
    if (container) {
        const div = container.querySelector('div');
        if (div) {
            div.innerHTML = '';
        }
    }

    networks.forEach(network => {
        const button = document.createElement('button');
        button.className = 'px-6 py-3 bg-slate-800/80 text-slate-300 rounded-xl hover:bg-sky-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:ring-offset-2 focus:ring-offset-slate-900 transition-all duration-300 border border-slate-700 hover:border-sky-500 shadow-lg hover:shadow-sky-500/20 font-medium';
        button.textContent = network.name;
        button.dataset.networkCode = network.code;
        button.onclick = () => {
            // Mise à jour visuelle du bouton sélectionné
            const container = document.getElementById('networkButtons');
            if (container) {
                const buttons = container.querySelectorAll('button');
                buttons.forEach(btn => {
                    btn.classList.remove('bg-sky-600', 'text-white', 'border-sky-500', 'shadow-sky-500/20');
                    btn.classList.add('bg-slate-800/80', 'text-slate-300', 'border-slate-700');
                });
            }
            button.classList.remove('bg-slate-800/80', 'text-slate-300', 'border-slate-700');
            button.classList.add('bg-sky-600', 'text-white', 'border-sky-500', 'shadow-sky-500/20');

            saveSelection({
                dept: document.getElementById('departementSelect').value,
                commune: document.getElementById('communeSelect').value,
                reseau: network.code
            });
            loadNetworkAnalyses(network.code);
        };
        const container = document.getElementById('networkButtons');
        if (container) {
            const div = container.querySelector('div');
            if (div) {
                div.appendChild(button);
            }
        }
    });

    const networkButtons = document.getElementById('networkButtons');
    if (networkButtons) {
        networkButtons.classList.remove('hidden');
    }
};

// Source virtuelle pour le HCO3 calculé depuis le TAC
const CALCULATED_SOURCE = { id: 'calcul', name: 'Calculé (TAC)', icon: 'fas fa-calculator', color: 'amber' };

// Formater une valeur numérique à la française (2 décimales max)
const formatValue = (value) => value.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

// Affichage des analyses fusionnées
const displayAnalyses = (analyses) => {
    // Regrouper les analyses par paramètre, de la plus récente à la plus ancienne
    const parameterGroups = {};
    Object.entries(PARAMETERS_OF_INTEREST).forEach(([name, info]) => {
        parameterGroups[name] = analyses
            .filter(a => a.code_parametre === info.code)
            .sort((a, b) => b.date - a.date);
    });

    // HCO3 : mesuré (code 1327) environ une fois par an, complété par le calcul depuis le TAC (mensuel)
    // pour les jours sans mesure directe
    const measuredHco3Days = new Set(parameterGroups['HCO3'].map(a => a.date.toISODate()));
    const computedHco3 = parameterGroups['TAC']
        .filter(a => !measuredHco3Days.has(a.date.toISODate()))
        .map(a => ({ ...a, value: calculateHCO3(a.value), source: CALCULATED_SOURCE }));
    parameterGroups['HCO3'] = [...parameterGroups['HCO3'], ...computedHco3].sort((a, b) => b.date - a.date);

    // Libellé affiché pour chaque paramètre
    const labels = {};
    Object.keys(PARAMETERS_OF_INTEREST).forEach(name => { labels[name] = name; });
    if (computedHco3.length > 0) {
        labels['HCO3'] = measuredHco3Days.size > 0 ? 'HCO3 (mesuré + calculé)' : 'HCO3 (calculé)';
    }

    // Sources ayant réellement fourni des mesures
    const usedSources = [...new Set(analyses.map(a => a.source))];

    displayCurrentValues(parameterGroups, labels, usedSources);
    displayCharts(parameterGroups, labels);
};

// Créer un badge source pour une carte paramètre
const createSourceBadge = (source, date) => {
    const badge = document.createElement('div');
    const colorMap = { sky: 'sky', emerald: 'emerald', amber: 'amber' };
    const c = colorMap[source.color] || 'sky';
    badge.className = `mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-${c}-500/10 border border-${c}-500/20`;

    const sourceIcon = document.createElement('i');
    sourceIcon.className = `${source.icon} text-${c}-500 text-xs`;
    badge.appendChild(sourceIcon);

    const text = document.createElement('span');
    text.className = `text-xs text-${c}-400`;
    const formattedDate = date.setLocale('fr').toLocaleString({ day: 'numeric', month: 'short', year: 'numeric' });
    text.textContent = `${source.name} — ${formattedDate}`;
    badge.appendChild(text);

    return badge;
};

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

// Créer la carte d'un paramètre : dernière valeur, statistiques 12 mois, source
const createParameterCard = (name, label, analyses) => {
    const lastAnalysis = analyses[0];
    const isComputed = lastAnalysis.source === CALCULATED_SOURCE;

    const card = document.createElement('div');
    card.className = 'bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50 backdrop-blur-sm hover:border-sky-500/50 transition-colors group';

    // Header
    const header = document.createElement('div');
    header.className = 'flex justify-between items-start mb-4';
    const h3 = document.createElement('h3');
    h3.className = 'text-lg font-semibold text-slate-300 group-hover:text-sky-400 transition-colors';
    h3.textContent = label;
    const iconDiv = document.createElement('div');
    iconDiv.className = `p-2 rounded-lg bg-slate-700/30 ${isComputed ? 'text-amber-500' : 'text-sky-500'}`;
    const icon = document.createElement('i');
    icon.className = isComputed ? 'fas fa-calculator' : 'fas fa-atom';
    iconDiv.appendChild(icon);
    header.appendChild(h3);
    header.appendChild(iconDiv);

    // Valeur
    const valueP = document.createElement('p');
    valueP.className = 'text-3xl font-bold text-white mb-2';
    valueP.textContent = formatValue(lastAnalysis.value) + ' ';
    const unitSpan = document.createElement('span');
    unitSpan.className = 'text-sm text-slate-500 font-normal ml-1';
    unitSpan.textContent = PARAMETERS_OF_INTEREST[name].unit;
    valueP.appendChild(unitSpan);

    card.appendChild(header);
    card.appendChild(valueP);

    // Variabilité sur 12 mois (si plusieurs mesures)
    const stats = computeYearStats(analyses);
    if (stats.n > 1) {
        const statsP = document.createElement('p');
        statsP.className = 'text-xs text-slate-400';
        statsP.textContent = `12 mois : min ${formatValue(stats.min)} · moy ${formatValue(stats.avg)} · max ${formatValue(stats.max)} (${stats.n} mesures)`;
        card.appendChild(statsP);
    }

    // Badge source + date
    card.appendChild(createSourceBadge(lastAnalysis.source, lastAnalysis.date));

    return card;
};

// Affichage des dernières valeurs
const displayCurrentValues = (parameterGroups, labels, usedSources) => {
    const container = document.getElementById('currentParameters');
    const grid = container ? container.querySelector('.grid') : null;
    if (!grid) return;
    grid.innerHTML = '';

    const currentValues = {};
    Object.entries(parameterGroups).forEach(([name, analyses]) => {
        if (analyses.length === 0) return;
        grid.appendChild(createParameterCard(name, labels[name], analyses));
        currentValues[name] = analyses[0].value;
    });

    container.classList.remove('hidden');

    // Bandeau global de source et fraîcheur des données
    displayDataSourceBanner(parameterGroups, usedSources);

    // S'assurer que toutes les valeurs sont définies avant de les passer au calculateur
    Object.keys(PARAMETERS_OF_INTEREST).forEach(key => {
        if (!(key in currentValues)) {
            currentValues[key] = 0;
        }
    });

    updateCalculator(currentValues);

    // Indicateurs brassicoles de l'eau du réseau
    const brewingIndicators = document.getElementById('brewingIndicators');
    if (brewingIndicators) {
        renderBrewingIndicators(brewingIndicators.querySelector('.grid'), currentValues);
        brewingIndicators.classList.remove('hidden');
    }
};

// Bandeau global indiquant les sources et la fraîcheur des données
const displayDataSourceBanner = (parameterGroups, usedSources) => {
    const dataSourceInfo = document.getElementById('dataSourceInfo');
    if (!dataSourceInfo) return;

    // Trouver la date de la mesure la plus récente
    let latestDate = null;
    Object.values(parameterGroups).forEach(analyses => {
        if (analyses.length > 0 && (!latestDate || analyses[0].date > latestDate)) {
            latestDate = analyses[0].date;
        }
    });

    const sourcesText = 'Sources : ' + usedSources.map(s => s.fullName).join(' + ');
    const mainSource = usedSources.includes(DATA_SOURCES.SISE_EAUX) ? DATA_SOURCES.SISE_EAUX : DATA_SOURCES.HUBEAU;

    dataSourceInfo.innerHTML = '';
    dataSourceInfo.className = 'mb-8 p-6 rounded-xl border text-sm space-y-4';

    if (!latestDate) {
        dataSourceInfo.classList.add('bg-slate-800/30', 'border-slate-700/30', 'text-slate-400');
        const text = document.createElement('span');
        text.textContent = sourcesText + ' — Mise à jour mensuelle.';
        dataSourceInfo.appendChild(text);
        dataSourceInfo.classList.remove('hidden');
        return;
    }

    const freshness = getDataFreshnessInfo(latestDate);
    const colorMap = { red: 'red', amber: 'amber', sky: 'sky', emerald: 'emerald' };
    const fc = colorMap[freshness.color] || 'sky';

    dataSourceInfo.classList.add(`bg-${fc}-500/5`, `border-${fc}-500/20`, 'text-slate-300');

    // Ligne 1 : Sources
    const sourceLine = document.createElement('div');
    sourceLine.className = 'flex items-center gap-3';
    const sourceIcon = document.createElement('i');
    sourceIcon.className = `${mainSource.icon} text-${fc}-500 flex-shrink-0`;
    sourceLine.appendChild(sourceIcon);
    const sourceText = document.createElement('span');
    sourceText.className = 'font-medium';
    sourceText.textContent = sourcesText;
    sourceLine.appendChild(sourceText);
    dataSourceInfo.appendChild(sourceLine);

    // Ligne 2 : Dates et fraîcheur
    const dateLine = document.createElement('div');
    dateLine.className = 'flex items-center gap-3 ml-7';
    const freshnessIcon = document.createElement('i');
    freshnessIcon.className = `${freshness.icon} text-${fc}-500 flex-shrink-0`;
    dateLine.appendChild(freshnessIcon);
    const dateText = document.createElement('span');
    const formattedLatest = latestDate.setLocale('fr').toLocaleString({ day: 'numeric', month: 'long', year: 'numeric' });
    dateText.textContent = 'Dernier prélèvement : ' + formattedLatest + ' — ' + freshness.text;
    dateLine.appendChild(dateText);
    dataSourceInfo.appendChild(dateLine);

    // Ligne 3 : Note sur le décalage Hub'Eau (si SISE-Eaux n'a rien fourni)
    if (mainSource === DATA_SOURCES.HUBEAU) {
        const noteLine = document.createElement('div');
        noteLine.className = 'flex items-center gap-3 ml-7 text-slate-500 text-xs';
        const noteIcon = document.createElement('i');
        noteIcon.className = 'fas fa-clock flex-shrink-0';
        noteLine.appendChild(noteIcon);
        const noteText = document.createElement('span');
        noteText.textContent = 'Hub\'Eau rediffuse les données SISE-Eaux avec un décalage. Les résultats les plus récents peuvent être disponibles sur le site officiel Orobnat.';
        noteLine.appendChild(noteText);
        dataSourceInfo.appendChild(noteLine);
    }

    dataSourceInfo.classList.remove('hidden');
};

// Instances Chart.js affichées (détruites avant chaque nouveau rendu)
let chartInstances = [];

// Couleurs des axes adaptées au thème sombre
const CHART_TEXT_COLOR = 'rgb(148, 163, 184)'; // slate-400
const CHART_TITLE_COLOR = 'rgb(226, 232, 240)'; // slate-200
const CHART_GRID_COLOR = 'rgba(148, 163, 184, 0.12)';

// Créer le graphique d'évolution d'un paramètre
const createChart = (name, label, analyses) => {
    const canvas = document.createElement('canvas');
    const unit = PARAMETERS_OF_INTEREST[name].unit;
    const color = PARAMETER_COLORS[name] || { color: 'rgb(59, 130, 246)', background: 'rgba(59, 130, 246, 0.1)' };

    const data = analyses
        .map(a => ({ x: a.date.toJSDate(), y: a.value }))
        .sort((a, b) => a.x - b.x);

    const axisTitle = (text) => ({ display: true, text, color: CHART_TEXT_COLOR, font: { weight: 'bold' } });

    chartInstances.push(new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            datasets: [{
                label,
                data,
                borderColor: color.color,
                backgroundColor: color.background,
                borderWidth: 2,
                tension: 0.3,
                pointRadius: 4,
                pointBackgroundColor: color.color,
                pointBorderColor: 'white',
                pointHoverRadius: 6,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: `${label} (${unit})`,
                    color: CHART_TITLE_COLOR,
                    font: { size: 16, weight: 'bold' },
                    padding: 20
                },
                legend: { display: false }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'month', displayFormats: { month: 'MMM yyyy' } },
                    title: axisTitle('Date'),
                    ticks: { color: CHART_TEXT_COLOR },
                    grid: { color: CHART_GRID_COLOR }
                },
                y: {
                    title: axisTitle(unit),
                    ticks: { color: CHART_TEXT_COLOR },
                    grid: { color: CHART_GRID_COLOR }
                }
            }
        }
    }));

    const wrapper = document.createElement('div');
    wrapper.className = 'bg-slate-800/40 p-6 rounded-2xl shadow-xl border border-slate-700/50 backdrop-blur-sm';
    wrapper.style.height = '400px';
    wrapper.appendChild(canvas);
    return wrapper;
};

// Affichage des graphiques
const displayCharts = (parameterGroups, labels) => {
    chartInstances.forEach(chart => chart.destroy());
    chartInstances = [];

    const chartsGrid = document.getElementById('chartsGrid');
    if (!chartsGrid) return;
    chartsGrid.innerHTML = '';

    Object.entries(parameterGroups).forEach(([name, analyses]) => {
        if (analyses.length === 0) return;
        chartsGrid.appendChild(createChart(name, labels[name], analyses));
    });

    const charts = document.getElementById('charts');
    if (charts) {
        charts.classList.remove('hidden');
    }
};

// Démarrer l'application
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
