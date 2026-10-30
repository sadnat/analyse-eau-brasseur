// Gestionnaire d'erreur global - ne pas exposer de détails en production
window.addEventListener('error', () => {
    console.error('Application error occurred');
});

// Fonction de debug — no-op en production, activable via ?debug=1
const DEBUG_ENABLED = new URLSearchParams(window.location.search).has('debug');
function debug(message) {
    if (DEBUG_ENABLED) console.log(message);
}

// Sélection courante (département, commune, réseau) : reflétée dans l'URL et mémorisée localement
const SELECTION_STORAGE_KEY = 'eau-brasseur:selection';

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

// Eaux de base du réseau (dernière, moyenne, maximum) et eau retenue dans le calculateur
let calculatorBaseWaters = null;
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
    span.textContent = `${formatValue(Math.round(value * 10) / 10)} ${unit}`;
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
    const { modifiedWater } = readCalculatorState();
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

    // Défilement horizontal sur petit écran plutôt qu'une colonne tronquée
    const scroller = document.createElement('div');
    scroller.className = 'overflow-x-auto';
    const table = document.createElement('table');
    table.className = 'w-full text-xs md:text-sm';
    const head = document.createElement('tr');
    head.className = 'text-left text-xs text-slate-400 uppercase tracking-wide';
    ['Paramètre (mg/L)', 'Modifiée', 'Cible', 'Écart'].forEach(text => {
        const th = document.createElement('th');
        th.className = 'pb-3 pr-3 font-semibold';
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
            { text: formatValue(Math.round(value * 10) / 10), className: 'py-2 text-white font-mono' },
            { text: formatValue(target), className: 'py-2 text-slate-400 font-mono' },
            { text: `${delta > 0 ? '+' : ''}${formatValue(Math.round(delta * 10) / 10)}`, className: `py-2 font-mono ${deltaColor}` }
        ].forEach(cell => {
            const td = document.createElement('td');
            // Valeurs numériques sur une ligne ; le nom du paramètre peut passer à la ligne
            td.className = `${cell.className} pr-3${cell.className.includes('font-mono') ? ' whitespace-nowrap' : ''}`;
            td.textContent = cell.text;
            row.appendChild(td);
        });
        table.appendChild(row);
    });
    scroller.appendChild(table);
    container.appendChild(scroller);

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

// Saisies courantes du calculateur et eau modifiée correspondante
const readCalculatorState = () => {
    const liters = parseFloat(document.getElementById('waterQuantity').value);
    const additions = {};
    MINERAL_INPUT_IDS.forEach(id => {
        additions[id] = parseFloat(document.getElementById(id).value) || 0;
    });
    const modeSelect = document.getElementById('baseWaterMode');
    return {
        liters,
        additions,
        mode: BASE_WATER_MODES[modeSelect ? modeSelect.value : 'derniere'],
        profile: getSelectedProfile(),
        baseWater: calculatorBaseWater,
        modifiedWater: calculateMineralAdditions(calculatorBaseWater, additions, liters)
    };
};

// Commune et réseau sélectionnés (codes et libellés)
const readSelectionLabels = () => {
    const communeSelect = document.getElementById('communeSelect');
    const networkButton = document.querySelector('#networkButtons button.bg-sky-600');
    return {
        communeCode: communeSelect.value,
        communeName: communeSelect.selectedOptions[0] ? communeSelect.selectedOptions[0].textContent : '',
        networkCode: networkButton ? networkButton.dataset.networkCode : '',
        networkName: networkButton ? networkButton.textContent : ''
    };
};

// Nom d'un sel tel qu'affiché dans le calculateur (libellé + formule)
const mineralLabel = (id) => {
    const label = document.querySelector(`label[for="${id}"]`);
    return label ? label.textContent.replace(/\s+/g, ' ').trim() : id;
};

// Télécharger l'eau de base et l'eau modifiée au format BeerXML
const exportBeerXml = () => {
    if (!calculatorBaseWater) return;
    const state = readCalculatorState();
    const selection = readSelectionLabels();
    const additionsText = MINERAL_INPUT_IDS
        .filter(id => state.additions[id] > 0)
        .map(id => `${mineralLabel(id)} : ${formatValue(state.additions[id])} g`)
        .join(' ; ');

    const xml = toBeerXmlWaters([
        {
            name: `Robinet — ${selection.networkName} (${state.mode})`,
            liters: state.liters,
            water: state.baseWater,
            notes: `${selection.communeName} — réseau ${selection.networkCode}. Sources : Hub'Eau / SISE-Eaux.`
        },
        {
            name: `Modifiée — ${state.profile ? state.profile.name : 'sans profil'}`,
            liters: state.liters,
            water: state.modifiedWater,
            notes: `Pour ${formatValue(state.liters)} L. ${additionsText || 'Aucun ajout.'}`
        }
    ]);

    const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `eau-${selection.communeCode}-${selection.networkCode}.xml`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};

// Ajouter un élément texte à un parent (sécurisé contre XSS)
const appendText = (parent, tag, text, className) => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    parent.appendChild(el);
    return el;
};

// Ajouter un tableau simple (en-têtes + lignes de texte)
const appendTable = (parent, headers, rows) => {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    headers.forEach(h => appendText(head, 'th', h));
    table.appendChild(head);
    rows.forEach(cells => {
        const row = document.createElement('tr');
        cells.forEach(c => appendText(row, 'td', c));
        table.appendChild(row);
    });
    parent.appendChild(table);
};

// Construire la fiche de brassage imprimable puis lancer l'impression
const buildBrewSheet = () => {
    const sheet = document.getElementById('brewSheet');
    if (!sheet || !calculatorBaseWater || !currentReport) return;
    const state = readCalculatorState();
    const selection = readSelectionLabels();
    const round = (value) => formatValue(Math.round((value || 0) * 10) / 10);
    const formatDate = (date) => date.setLocale('fr').toLocaleString({ day: 'numeric', month: 'long', year: 'numeric' });

    sheet.innerHTML = '';
    appendText(sheet, 'h1', 'Fiche eau de brassage');
    appendText(sheet, 'p', `${selection.communeName} — réseau ${selection.networkName} (${selection.networkCode})`);
    appendText(sheet, 'p', `Sources : ${currentReport.usedSources.map(s => s.name).join(' + ')}`
        + (currentReport.latestDate ? ` — dernier prélèvement : ${formatDate(currentReport.latestDate)}` : ''));
    appendText(sheet, 'p', `Eau de base : ${state.mode} — volume : ${formatValue(state.liters || 0)} L — profil cible : ${state.profile ? state.profile.name : 'aucun'}`);

    appendText(sheet, 'h2', 'Ajouts de sels');
    const salts = MINERAL_INPUT_IDS.filter(id => state.additions[id] > 0);
    if (salts.length > 0) {
        appendTable(sheet, ['Sel', 'Quantité'], salts.map(id => [mineralLabel(id), `${formatValue(state.additions[id])} g`]));
    } else {
        appendText(sheet, 'p', 'Aucun ajout.');
    }

    appendText(sheet, 'h2', 'Composition (mg/L)');
    appendTable(sheet,
        ['Paramètre', 'Eau de base', 'Eau modifiée', ...(state.profile ? [`Cible ${state.profile.name}`] : [])],
        PROFILE_IONS.map(ion => [
            ion,
            round(state.baseWater[ion]),
            round(state.modifiedWater[ion]),
            ...(state.profile ? [formatValue(state.profile.ions[ion])] : [])
        ]));

    appendText(sheet, 'h2', 'Indicateurs');
    const ratio = (water) => {
        const value = calculateSulfateChlorideRatio(water);
        return value === null ? '—' : formatValue(Math.round(value * 100) / 100);
    };
    appendTable(sheet, ['Indicateur', 'Eau de base', 'Eau modifiée'], [
        ['Alcalinité résiduelle (mg/L CaCO₃)',
            formatValue(Math.round(calculateResidualAlkalinity(state.baseWater))),
            formatValue(Math.round(calculateResidualAlkalinity(state.modifiedWater)))],
        ['Ratio SO₄ / Cl', ratio(state.baseWater), ratio(state.modifiedWater)]
    ]);

    if (currentReport.qualityItems.length > 0) {
        appendText(sheet, 'h2', 'Qualité de l\'eau');
        currentReport.qualityItems.forEach(item => {
            appendText(sheet, 'p', `${item.title} (${item.display}, ${formatDate(item.date)}) : ${item.message}`);
        });
    }

    appendText(sheet, 'p', `Lien : ${window.location.href}`, 'brew-sheet-meta');
    appendText(sheet, 'p', `Édité le ${formatDate(luxon.DateTime.now())} — valeurs indicatives, à vérifier avant brassage.`, 'brew-sheet-meta');
};

const printBrewSheet = () => {
    buildBrewSheet();
    window.print();
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

    // Eau de base : dernière mesure, moyenne ou maximum sur 12 mois
    const baseWaterMode = document.getElementById('baseWaterMode');
    if (baseWaterMode) {
        baseWaterMode.addEventListener('change', () => {
            if (!calculatorBaseWaters) return;
            calculatorBaseWater = calculatorBaseWaters[baseWaterMode.value];
            solverNote = '';
            renderCalculator();
        });
    }

    // Export et fiche imprimable
    const exportButton = document.getElementById('exportBeerXml');
    if (exportButton) exportButton.addEventListener('click', exportBeerXml);
    const printButton = document.getElementById('printSheet');
    if (printButton) printButton.addEventListener('click', printBrewSheet);

    ['waterQuantity', ...MINERAL_INPUT_IDS].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', updateCalculations);
        }
    });

    calculatorInitialized = true;
}

// Mettre à jour les eaux de base du calculateur ({ derniere, moyenne, maximum })
function updateCalculator(baseWaters) {
    calculatorBaseWaters = baseWaters;
    const baseWaterMode = document.getElementById('baseWaterMode');
    calculatorBaseWater = baseWaters[baseWaterMode ? baseWaterMode.value : 'derniere'];
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
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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

        departements.sort((a, b) => departementSortKey(a.code) - departementSortKey(b.code));
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
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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

// Délai maximal des requêtes : une API lente ne doit pas bloquer l'affichage de l'autre source
const FETCH_TIMEOUT_MS = 15000;

// Requêter le backend SISE-Eaux pour les réseaux d'une commune
const fetchSiseNetworks = async (communeCode) => {
    const response = await fetch(`/api/sise/communes_udi?code_commune=${encodeURIComponent(communeCode)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`SISE HTTP ${response.status}`);
    return response.json();
};

// Requêter le backend SISE-Eaux pour les analyses d'un réseau
const fetchSiseAnalyses = async (networkCode, paramCodes) => {
    const response = await fetch(`/api/sise/resultats?code_reseau=${encodeURIComponent(networkCode)}&code_parametre=${encodeURIComponent(paramCodes)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`SISE HTTP ${response.status}`);
    return response.json();
};

// Requêter Hub'Eau pour les réseaux d'une commune
const fetchHubEauNetworks = async (communeCode) => {
    const response = await fetch(`https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/communes_udi?code_commune=${encodeURIComponent(communeCode)}&size=100`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Hub'Eau HTTP ${response.status}`);
    return response.json();
};

// Requêter Hub'Eau pour les analyses d'un réseau
const fetchHubEauAnalyses = async (networkCode, paramCodes) => {
    const response = await fetch(`https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_reseau=${encodeURIComponent(networkCode)}&code_parametre=${encodeURIComponent(paramCodes)}&size=5000`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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

// Chargement des analyses pour un réseau — fusionne Hub'Eau et SISE-Eaux
const loadNetworkAnalyses = async (networkCode) => {
    const requestId = ++currentRequestId;
    try {
        setLoading(true);
        hideError();

        const paramCodes = [...Object.values(PARAMETERS_OF_INTEREST), ...Object.values(QUALITY_PARAMETERS)]
            .map(p => p.code).join(',');

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

// Affichage des analyses fusionnées
// Synthèse du réseau affiché, reprise par la fiche de brassage
let currentReport = null;

const displayAnalyses = (analyses) => {
    const { parameterGroups, labels } = buildParameterGroups(analyses);
    const qualityItems = assessWaterQuality(groupByParameter(analyses, QUALITY_PARAMETERS));

    // Sources ayant réellement fourni des mesures
    const usedSources = [...new Set(analyses.map(a => a.source))];
    const latestDate = Object.values(parameterGroups)
        .filter(group => group.length > 0)
        .reduce((latest, group) => (!latest || group[0].date > latest ? group[0].date : latest), null);
    currentReport = { usedSources, latestDate, qualityItems };

    displayCurrentValues(parameterGroups, labels, usedSources);
    displayQualityAlerts(qualityItems);
    displayCharts(parameterGroups, labels);
};

// Alertes qualité (chlore, nitrates, fer, manganèse) ; section masquée si rien n'est mesuré
const displayQualityAlerts = (items) => {
    const section = document.getElementById('qualityAlerts');
    if (!section) return;
    const grid = section.querySelector('.grid');
    grid.innerHTML = '';
    items.forEach(item => {
        const date = item.date.setLocale('fr').toLocaleString({ day: 'numeric', month: 'short', year: 'numeric' });
        grid.appendChild(createIndicatorTile(
            `${item.title} — ${date}`,
            item.display,
            { text: item.message, color: QUALITY_LEVEL_COLORS[item.level] }
        ));
    });
    section.classList.toggle('hidden', items.length === 0);
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

    Object.entries(parameterGroups).forEach(([name, analyses]) => {
        if (analyses.length === 0) return;
        grid.appendChild(createParameterCard(name, labels[name], analyses));
    });

    container.classList.remove('hidden');

    // Bandeau global de source et fraîcheur des données
    displayDataSourceBanner(parameterGroups, usedSources);

    // Eaux de base du calculateur (paramètres absents à 0)
    const baseWaters = buildBaseWaters(parameterGroups);
    updateCalculator(baseWaters);

    // Indicateurs brassicoles de l'eau du réseau (dernière mesure)
    const brewingIndicators = document.getElementById('brewingIndicators');
    if (brewingIndicators) {
        renderBrewingIndicators(brewingIndicators.querySelector('.grid'), baseWaters.derniere);
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
                    // Unité choisie automatiquement selon la période couverte (mois ou années)
                    adapters: { date: { locale: 'fr' } },
                    time: { displayFormats: { month: 'MMM yyyy', quarter: 'MMM yyyy', year: 'yyyy' } },
                    title: axisTitle('Date'),
                    ticks: { color: CHART_TEXT_COLOR, maxRotation: 0, autoSkipPadding: 16 },
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
