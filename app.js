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
let currentSelection = {};

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
    if (params.has('commune')) {
        return sanitizeSelection(Object.fromEntries(params));
    }
    try {
        return sanitizeSelection(JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY)) || {});
    } catch {
        return {};
    }
};

// --- Recherche de commune (geo.api.gouv.fr) ---

const GEO_API_URL = 'https://geo.api.gouv.fr/communes';
const GEO_FIELDS = 'fields=nom,code,codesPostaux,departement,population';
const SEARCH_DEBOUNCE_MS = 250;
let searchTimer = null;
let searchRequestId = 0;
let searchResults = [];
let activeSuggestion = -1;

const fetchCommunes = async (query) => {
    const response = await fetch(`${GEO_API_URL}?${query}&${GEO_FIELDS}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`geo.api HTTP ${response.status}`);
    const communes = await response.json();
    if (!Array.isArray(communes)) throw new Error('Format de réponse invalide');
    return communes;
};

// Libellé affiché d'une commune : « Foix (09000) — Ariège »
const communeLabel = (commune, postalCode) => {
    const cp = postalCode || (commune.codesPostaux || [])[0];
    const dept = commune.departement ? ` — ${commune.departement.nom}` : '';
    return `${commune.nom}${cp ? ` (${cp})` : ''}${dept}`;
};

const closeSuggestions = () => {
    const list = document.getElementById('communeSuggestions');
    const input = document.getElementById('communeSearch');
    list.classList.add('hidden');
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    searchResults = [];
    activeSuggestion = -1;
};

const highlightSuggestion = (index) => {
    const input = document.getElementById('communeSearch');
    const options = document.querySelectorAll('#communeSuggestions [role="option"]');
    activeSuggestion = index;
    options.forEach((option, i) => {
        const active = i === index;
        option.setAttribute('aria-selected', String(active));
        option.classList.toggle('bg-sky-600/30', active);
        if (active) {
            input.setAttribute('aria-activedescendant', option.id);
            option.scrollIntoView({ block: 'nearest' });
        }
    });
};

const renderSuggestions = (communes, postalCode) => {
    const list = document.getElementById('communeSuggestions');
    const input = document.getElementById('communeSearch');
    list.innerHTML = '';
    searchResults = communes;
    activeSuggestion = -1;

    if (communes.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'px-4 py-3 text-sm text-slate-400';
        empty.textContent = 'Aucune commune trouvée.';
        list.appendChild(empty);
    }
    communes.forEach((commune, i) => {
        const option = document.createElement('li');
        option.id = `commune-option-${i}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.className = 'px-4 py-2 cursor-pointer hover:bg-sky-600/20';
        const name = document.createElement('span');
        name.className = 'block text-white';
        name.textContent = commune.nom;
        const details = document.createElement('span');
        details.className = 'block text-xs text-slate-400';
        const cp = postalCode || (commune.codesPostaux || [])[0] || '';
        details.textContent = [cp, commune.departement ? `${commune.departement.nom} (${commune.departement.code})` : '']
            .filter(Boolean).join(' · ');
        option.append(name, details);
        // mousedown plutôt que click : se déclenche avant la perte de focus du champ
        option.addEventListener('mousedown', (e) => {
            e.preventDefault();
            chooseCommune(commune, postalCode);
        });
        list.appendChild(option);
    });
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
};

const searchCommunes = async (text) => {
    const value = text.trim();
    const requestId = ++searchRequestId;
    let query = null;
    let postalCode = null;
    if (/^\d{5}$/.test(value)) {
        query = `codePostal=${value}`;
        postalCode = value;
    } else if (value.length >= 2 && !/^\d+$/.test(value)) {
        query = `nom=${encodeURIComponent(value)}&boost=population&limit=8`;
    }
    if (!query) {
        closeSuggestions();
        return;
    }
    try {
        const communes = await fetchCommunes(query);
        if (requestId !== searchRequestId) return;
        // Un code postal peut couvrir de nombreuses communes : les plus peuplées d'abord
        if (postalCode) communes.sort((a, b) => (b.population || 0) - (a.population || 0));
        renderSuggestions(communes.slice(0, 8), postalCode);
    } catch (error) {
        if (requestId !== searchRequestId) return;
        closeSuggestions();
        showError('Recherche de communes indisponible pour le moment.', () => searchCommunes(text));
        console.error(error);
    }
};

// Commune choisie : en-tête compact, puis chargement des réseaux
const chooseCommune = (commune, postalCode) => {
    closeSuggestions();
    document.getElementById('communeSearch').value = communeLabel(commune, postalCode);
    currentSelection = {
        dept: commune.departement ? commune.departement.code : undefined,
        commune: commune.code,
        communeName: commune.nom
    };
    saveSelection(currentSelection);
    document.body.classList.add('has-selection');
    document.getElementById('welcome').classList.add('hidden');
    hideResults();
    hideError();
    return loadAnalyses(commune.code);
};

// Commune correspondant à la position de l'utilisateur
const locateUser = () => {
    if (!navigator.geolocation) {
        showError('La géolocalisation n\'est pas disponible dans ce navigateur.');
        return;
    }
    announce('Recherche de votre position…');
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
        try {
            const [commune] = await fetchCommunes(`lat=${coords.latitude}&lon=${coords.longitude}`);
            if (!commune) throw new Error('Aucune commune à cette position');
            chooseCommune(commune);
        } catch (error) {
            showError('Impossible de trouver la commune correspondant à votre position.', locateUser);
            console.error(error);
        }
    }, () => {
        showError('Position refusée ou indisponible : recherchez votre commune par son nom.');
    }, { timeout: 10000, maximumAge: 600000 });
};

const initCommuneSearch = () => {
    const input = document.getElementById('communeSearch');
    input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => searchCommunes(input.value), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (e) => {
        const count = searchResults.length;
        if (e.key === 'ArrowDown' && count > 0) {
            e.preventDefault();
            highlightSuggestion((activeSuggestion + 1) % count);
        } else if (e.key === 'ArrowUp' && count > 0) {
            e.preventDefault();
            highlightSuggestion((activeSuggestion - 1 + count) % count);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (count > 0) chooseCommune(searchResults[Math.max(activeSuggestion, 0)]);
        } else if (e.key === 'Escape') {
            closeSuggestions();
        }
    });
    input.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
    input.addEventListener('focus', () => input.select());
    document.getElementById('searchForm').addEventListener('submit', (e) => e.preventDefault());
    document.getElementById('locateMe').addEventListener('click', locateUser);
};

// --- Onglets des résultats ---

const TABS = ['eau', 'calculateur', 'historique'];

const activateTab = (name, { focus = false, updateUrl = true } = {}) => {
    if (!TABS.includes(name)) name = 'eau';
    TABS.forEach(tab => {
        const button = document.getElementById(`tab-${tab}`);
        const panel = document.getElementById(`panel-${tab}`);
        const selected = tab === name;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        panel.hidden = !selected;
        if (selected && focus) button.focus();
    });
    if (name === 'calculateur') renderCalculator();
    if (updateUrl) {
        const url = new URL(window.location.href);
        if (name === 'eau') url.searchParams.delete('onglet');
        else url.searchParams.set('onglet', name);
        window.history.replaceState(null, '', url);
    }
};

const initTabs = () => {
    TABS.forEach((tab, index) => {
        const button = document.getElementById(`tab-${tab}`);
        button.addEventListener('click', () => activateTab(tab));
        // Flèches gauche/droite, Début/Fin : navigation entre onglets (motif ARIA)
        button.addEventListener('keydown', (e) => {
            const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 };
            if (!(e.key in moves)) return;
            e.preventDefault();
            activateTab(TABS[(moves[e.key] + TABS.length) % TABS.length], { focus: true });
        });
    });
    activateTab(new URLSearchParams(window.location.search).get('onglet') || 'eau', { updateUrl: false });
};

// --- Restauration d'une sélection (lien partagé, dernière visite, exemple) ---

const applySelection = async (selection) => {
    if (!selection.commune) return;
    try {
        const response = await fetch(`${GEO_API_URL}/${encodeURIComponent(selection.commune)}?${GEO_FIELDS}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`geo.api HTTP ${response.status}`);
        await chooseCommune(await response.json());
    } catch (error) {
        showError('Impossible de retrouver la commune enregistrée : recherchez-la par son nom.');
        console.error(error);
        return;
    }

    if (!selection.reseau) return;
    const button = document.querySelector(`#networkButtons button[data-network-code="${selection.reseau}"]`);
    // Réseau unique : déjà sélectionné automatiquement
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
};

const restoreSelection = () => applySelection(readSelection());

// Exemple : Foix (Ariège), réseau du centre-ville
const EXAMPLE_SELECTION = { dept: '09', commune: '09122', reseau: '009001053' };

// Fonction principale de l'application (script chargé en defer : le DOM est prêt)
function initApp() {
    initCommuneSearch();
    initTabs();
    document.getElementById('tryExample').addEventListener('click', () => applySelection(EXAMPLE_SELECTION));
    document.getElementById('retryButton').addEventListener('click', () => {
        const retry = retryAction;
        hideError();
        if (retry) retry();
    });
    updateSyncInfo();
    restoreSelection();
}

// Couleurs pour les différents paramètres
const PARAMETER_COLORS = {
    'CALCIUM (CA)': { color: 'rgb(59, 130, 246)', background: 'rgba(59, 130, 246, 0.1)' }, // Bleu
    'MAGNESIUM (MG)': { color: 'rgb(16, 185, 129)', background: 'rgba(16, 185, 129, 0.1)' }, // Vert
    'SODIUM (NA)': { color: 'rgb(245, 158, 11)', background: 'rgba(245, 158, 11, 0.1)' }, // Orange
    'SULFATES (SO4)': { color: 'rgb(139, 92, 246)', background: 'rgba(139, 92, 246, 0.1)' }, // Violet
    'CHLORURES': { color: 'rgb(239, 68, 68)', background: 'rgba(239, 68, 68, 0.1)' }, // Rouge
    'POTASSIUM (K)': { color: 'rgb(236, 72, 153)', background: 'rgba(236, 72, 153, 0.1)' }, // Rose
    'PH': { color: 'rgb(129, 140, 248)', background: 'rgba(129, 140, 248, 0.1)' }, // Indigo clair
    'TAC': { color: 'rgb(148, 163, 184)', background: 'rgba(148, 163, 184, 0.1)' }, // Gris clair
    'HCO3': { color: 'rgb(45, 212, 191)', background: 'rgba(45, 212, 191, 0.1)' } // Turquoise
};

// Bouton d'aide « ? » et sa bulle (accessible au clavier, état dans aria-expanded)
let helpCounter = 0;
const createHelp = (helpKey) => {
    const id = `help-${helpKey}-${++helpCounter}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'help-button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);
    button.setAttribute('aria-label', 'Explication');
    button.textContent = '?';
    const bubble = document.createElement('p');
    bubble.id = id;
    bubble.hidden = true;
    bubble.className = 'mt-3 text-xs leading-relaxed text-slate-300 border-l-2 border-sky-500/60 pl-3';
    bubble.textContent = HELP_TEXTS[helpKey];
    button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(open));
        bubble.hidden = !open;
    });
    return { button, bubble };
};

// Icônes des niveaux de qualité : le statut ne repose jamais sur la couleur seule
const QUALITY_LEVEL_ICONS = { ok: 'fa-circle-check', vigilance: 'fa-triangle-exclamation', alerte: 'fa-circle-exclamation' };

// Créer une tuile d'indicateur (titre, valeur, interprétation, aide optionnelle)
const createIndicatorTile = (title, value, interpretation, helpKey = null) => {
    const tile = document.createElement('div');
    tile.className = 'p-4 rounded-xl bg-slate-800/40 border border-slate-700/50';
    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-2 mb-2';
    const titleEl = document.createElement('p');
    titleEl.className = 'text-xs font-semibold text-slate-300 uppercase tracking-wide';
    titleEl.textContent = title;
    header.appendChild(titleEl);
    const help = helpKey ? createHelp(helpKey) : null;
    if (help) header.appendChild(help.button);

    const valueEl = document.createElement('p');
    valueEl.className = 'text-2xl font-bold text-white';
    valueEl.textContent = value;
    const hintEl = document.createElement('p');
    hintEl.className = `text-xs mt-1 flex items-start gap-1.5 ${interpretation.color}`;
    const icon = document.createElement('i');
    icon.className = `fas ${interpretation.icon || 'fa-circle-info'} mt-0.5`;
    icon.setAttribute('aria-hidden', 'true');
    const hintText = document.createElement('span');
    hintText.textContent = interpretation.text;
    hintEl.append(icon, hintText);

    tile.append(header, valueEl, hintEl);
    if (help) tile.appendChild(help.bubble);
    return tile;
};

// Afficher les indicateurs brassicoles d'une eau dans un conteneur
const renderBrewingIndicators = (container, water) => {
    if (!container) return;
    container.innerHTML = '';

    const th = calculateTotalHardness(water);
    container.appendChild(createIndicatorTile(
        'Dureté totale',
        `${formatValue(Math.round(th * 10) / 10)} °f`,
        describeHardness(th),
        'durete'
    ));

    const ra = calculateResidualAlkalinity(water);
    container.appendChild(createIndicatorTile(
        'Alcalinité résiduelle',
        `${formatValue(Math.round(ra))} mg/L CaCO₃`,
        describeResidualAlkalinity(ra),
        'alcalinite'
    ));

    const ratio = calculateSulfateChlorideRatio(water);
    container.appendChild(createIndicatorTile(
        'Ratio SO₄ / Cl',
        ratio === null ? '—' : formatValue(Math.round(ratio * 100) / 100),
        describeSulfateChlorideRatio(ratio, water),
        'ratio'
    ));

    const balance = calculateIonBalance(water);
    container.appendChild(createIndicatorTile(
        'Balance ionique',
        balance ? `${formatValue(Math.round(balance.error * 10) / 10)} %` : '—',
        describeIonBalance(balance),
        'balance'
    ));
};

// Indicateurs compacts du panneau de résultat du calculateur (grille 2 × 2)
const renderCompactIndicators = (container, water) => {
    container.innerHTML = '';
    const ra = calculateResidualAlkalinity(water);
    const ratio = calculateSulfateChlorideRatio(water);
    const balance = calculateIonBalance(water);
    const th = calculateTotalHardness(water);
    [
        ['Dureté', `${formatValue(Math.round(th * 10) / 10)} °f`, describeHardness(th)],
        ['Alcalinité résiduelle', `${formatValue(Math.round(ra))} mg/L CaCO₃`, describeResidualAlkalinity(ra)],
        ['Ratio SO₄ / Cl', ratio === null ? '—' : formatValue(Math.round(ratio * 100) / 100), describeSulfateChlorideRatio(ratio, water)],
        ['Balance ionique', balance ? `${formatValue(Math.round(balance.error * 10) / 10)} %` : '—', describeIonBalance(balance)]
    ].forEach(([label, value, interpretation]) => {
        const cell = document.createElement('div');
        cell.className = 'p-2 rounded-lg bg-slate-800/50';
        appendText(cell, 'p', label, 'text-xs text-slate-400');
        appendText(cell, 'p', value, 'text-sm font-semibold text-white');
        const hint = document.createElement('p');
        hint.className = `text-xs leading-snug flex items-start gap-1 ${interpretation.color}`;
        const icon = document.createElement('i');
        icon.className = `fas ${interpretation.icon || 'fa-circle-info'} mt-0.5`;
        icon.setAttribute('aria-hidden', 'true');
        hint.append(icon, interpretation.text);
        cell.appendChild(hint);
        container.appendChild(cell);
    });
};

// Eaux de base du réseau (dernière, moyenne, maximum) et eau retenue dans le calculateur
let calculatorBaseWaters = null;
let calculatorBaseWater = null;
let calculatorInitialized = false;

// Ajouts du calculateur : sels en grammes (identifiants = clés de MINERAL_CONVERSIONS), acides en mL (clés de ACIDS)
const SALTS = [
    { id: 'calciumSulfate', name: 'Sulfate de calcium (gypse)', formula: 'CaSO₄·2H₂O' },
    { id: 'magnesiumSulfate', name: 'Sulfate de magnésium (sel d\'Epsom)', formula: 'MgSO₄·7H₂O' },
    { id: 'calciumChloride', name: 'Chlorure de calcium', formula: 'CaCl₂·2H₂O' },
    { id: 'sodiumChloride', name: 'Chlorure de sodium', formula: 'NaCl' },
    { id: 'calciumCarbonate', name: 'Carbonate de calcium (craie)', formula: 'CaCO₃' },
    { id: 'sodiumBicarbonate', name: 'Bicarbonate de sodium', formula: 'NaHCO₃' },
    { id: 'potassiumChloride', name: 'Chlorure de potassium', formula: 'KCl' },
    { id: 'ams', name: 'AMS (acide de brassage)', formula: 'HCl + H₂SO₄', unit: 'mL', step: 0.5, acid: true },
    { id: 'phosphoric75', name: 'Acide phosphorique 75 %', formula: 'H₃PO₄', unit: 'mL', step: 0.1, acid: true },
    { id: 'lactic80', name: 'Acide lactique 80 %', formula: 'C₃H₆O₃', unit: 'mL', step: 0.1, acid: true }
];
const MINERAL_INPUT_IDS = SALTS.map(salt => salt.id);
const SALT_UNITS = Object.fromEntries(SALTS.map(salt => [salt.id, salt.unit || 'g']));
const SALT_STEP = 0.1;

// Champs de sels avec boutons −/+ (générés une seule fois)
const renderSaltInputs = () => {
    const saltsGrid = document.getElementById('saltInputs');
    const acidsGrid = document.getElementById('acidInputs');
    SALTS.forEach(salt => {
        const container = salt.acid ? acidsGrid : saltsGrid;
        const field = document.createElement('div');
        const label = document.createElement('label');
        label.htmlFor = salt.id;
        label.className = 'block text-sm font-medium text-slate-200 mb-2';
        label.textContent = `${salt.name} `;
        const formula = document.createElement('span');
        formula.className = 'text-xs text-amber-400 font-mono';
        formula.textContent = salt.formula;
        label.appendChild(formula);

        const row = document.createElement('div');
        row.className = 'flex items-stretch rounded-xl border border-slate-600 bg-slate-900/60 focus-within:ring-2 focus-within:ring-sky-500/60';
        const input = document.createElement('input');
        input.type = 'number';
        input.id = salt.id;
        input.value = '0';
        input.min = '0';
        const step = salt.step || SALT_STEP;
        const unitLabel = salt.unit || 'g';
        input.step = String(step);
        input.inputMode = 'decimal';
        input.className = 'min-w-0 flex-1 bg-transparent px-3 py-2.5 text-white font-mono text-center focus:outline-none';
        const stepButton = (delta, symbol, action) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'w-11 shrink-0 text-lg text-slate-300 hover:text-white hover:bg-slate-700/60 focus:outline-none focus-visible:bg-slate-700';
            button.textContent = symbol;
            button.setAttribute('aria-label', `${action} ${salt.name} de ${formatValue(step)} ${unitLabel}`);
            button.addEventListener('click', () => {
                const next = Math.max(0, Math.round(((parseFloat(input.value) || 0) + delta) * 10) / 10);
                input.value = String(next);
                updateCalculations();
            });
            return button;
        };
        const unit = document.createElement('span');
        unit.className = 'self-center pr-1 text-slate-400 text-sm';
        unit.setAttribute('aria-hidden', 'true');
        unit.textContent = unitLabel;
        row.append(stepButton(-step, '−', 'Diminuer'), input, unit, stepButton(step, '+', 'Augmenter'));
        input.addEventListener('input', updateCalculations);

        field.append(label, row);
        container.appendChild(field);
    });
};

// Couleur de la barre « après ajouts » selon l'écart à la cible (neutre sans profil)
const DEVIATION_BAR_COLORS = { ok: 'bg-emerald-400', proche: 'bg-amber-400', loin: 'bg-red-400' };
const DEVIATION_TEXT = { ok: 'conforme à la cible', proche: 'proche de la cible', loin: 'loin de la cible' };

// Barres par ion : eau de base, après ajouts et repère de cible
const renderIonBars = (state) => {
    const container = document.getElementById('ionBars');
    container.innerHTML = '';
    const fmt = (v) => formatValue(Math.round((v || 0) * 10) / 10);
    PROFILE_IONS.forEach(ion => {
        const base = state.baseWater[ion] || 0;
        const modified = state.modifiedWater[ion] || 0;
        const target = state.profile ? state.profile.ions[ion] : null;
        const scale = { min: 0, max: Math.max(base, modified, target || 0, 1) * 1.1 };
        const deviation = target === null ? null : profileDeviation(modified, target);

        const row = document.createElement('div');
        row.dataset.ion = ion;
        const header = document.createElement('div');
        header.className = 'flex items-baseline justify-between gap-2 text-sm';
        const name = document.createElement('span');
        name.className = 'text-slate-200';
        name.textContent = PARAMETERS_OF_INTEREST[ion].label;
        const values = document.createElement('span');
        values.className = 'font-mono text-xs text-slate-300';
        const baseSpan = document.createElement('span');
        baseSpan.className = 'ion-base';
        baseSpan.textContent = fmt(base);
        const modifiedSpan = document.createElement('span');
        modifiedSpan.className = 'ion-modified text-white font-semibold';
        modifiedSpan.textContent = fmt(modified);
        values.append(baseSpan, ' → ', modifiedSpan);
        if (target !== null) values.append(` / ${formatValue(target)}`);
        values.append(' mg/L');
        header.append(name, values);

        const bar = document.createElement('div');
        bar.className = 'relative mt-1 h-3 rounded-full bg-slate-800';
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', `${PARAMETERS_OF_INTEREST[ion].label} : ${fmt(base)} puis ${fmt(modified)} mg/L`
            + (target !== null ? `, cible ${formatValue(target)} mg/L, ${DEVIATION_TEXT[deviation]}` : ''));
        const fill = (value, className) => {
            const el = document.createElement('div');
            el.className = `absolute left-0 rounded-full ${className}`;
            el.style.width = `${gaugePosition(value, scale)}%`;
            bar.appendChild(el);
        };
        fill(modified, `top-0 h-3 opacity-80 ${deviation ? DEVIATION_BAR_COLORS[deviation] : 'bg-sky-400'}`);
        fill(base, 'top-1 h-1 bg-slate-500');
        if (target !== null) {
            const marker = document.createElement('div');
            marker.className = 'absolute -top-1 h-5 w-0.5 bg-white';
            marker.style.left = `${gaugePosition(target, scale)}%`;
            bar.appendChild(marker);
        }
        row.append(header, bar);
        container.appendChild(row);
    });
};

// Résumé collant (mobile) : principaux ions et ratio de l'eau modifiée
const renderSummaryBar = (water) => {
    const bar = document.getElementById('calcSummaryBar');
    const ratio = calculateSulfateChlorideRatio(water);
    const fmt = (v) => formatValue(Math.round(v || 0));
    bar.textContent = `Ca ${fmt(water['CALCIUM (CA)'])} · SO₄ ${fmt(water['SULFATES (SO4)'])} · Cl ${fmt(water['CHLORURES'])} mg/L`
        + (ratio === null ? '' : ` · SO₄/Cl ${formatValue(Math.round(ratio * 100) / 100)}`);
};

// Effet des acides : alcalinité neutralisée, excès d'acide et lactate
const renderAcidHint = (state) => {
    const hint = document.getElementById('acidHint');
    const fmt = (v) => formatValue(Math.round(v));
    const acidIds = Object.keys(ACIDS).filter(id => state.additions[id] > 0);
    hint.innerHTML = '';
    const line = (text, className = 'text-slate-400') => appendText(hint, 'p', text, className);
    if (acidIds.length === 0) {
        line('Par mL et par litre d\'eau, l\'AMS neutralise ≈ 205 mg/L CaCO₃ d\'alcalinité (et apporte chlorures et sulfates), '
            + 'l\'acide phosphorique 75 % ≈ 614 et l\'acide lactique 80 % ≈ 518.');
        return;
    }
    // Alcalinité disponible : eau de base + bicarbonates éventuellement ajoutés (avant acides)
    const withoutAcid = { ...state.additions };
    acidIds.forEach(id => { withoutAcid[id] = 0; });
    const available = calculateMineralAdditions(state.baseWater, withoutAcid, state.liters)['HCO3'];
    const { neutralized, excess } = acidEffect(state.additions, state.liters, available);
    if (excess > 1) {
        line(`Toute l'alcalinité est neutralisée (${fmt(neutralized)} mg/L CaCO₃) ; l'excès d'acide (${fmt(excess)} mg/L CaCO₃) abaissera directement le pH de la maische.`, 'text-amber-300');
    } else {
        line(`Les acides neutralisent ${fmt(neutralized)} mg/L CaCO₃ d'alcalinité, sur ${fmt(available / 61.02 * 50.04)} disponibles.`);
    }
    // Lactate : goût acidulé au-delà du seuil de perception
    const lactate = state.liters > 0 ? (state.additions.lactic80 || 0) * ACIDS.lactic80.lactatePerMl / state.liters : 0;
    if (lactate > LACTATE_TASTE_THRESHOLD) {
        line(`Lactate ${fmt(lactate)} mg/L : au-delà de ~${LACTATE_TASTE_THRESHOLD} mg/L, un goût acidulé peut apparaître.`, 'text-amber-300');
    }
};

// Recalculer et afficher l'eau modifiée à partir des saisies
const updateCalculations = () => {
    if (!calculatorBaseWater) return;
    const state = readCalculatorState();
    renderIonBars(state);
    // Légende : couleurs d'écart seulement quand un profil cible est choisi
    document.getElementById('legendNeutral').classList.toggle('hidden', Boolean(state.profile));
    document.getElementById('legendDeviation').classList.toggle('hidden', !state.profile);
    renderCompactIndicators(document.getElementById('modifiedIndicators'), state.modifiedWater);
    renderAcidHint(state);
    renderSummaryBar(state.modifiedWater);
    const note = document.getElementById('solverNote');
    note.textContent = solverNote;
    note.classList.toggle('hidden', !solverNote);
};

// Profil cible sélectionné (ou null)
const getSelectedProfile = () => {
    const select = document.getElementById('targetProfile');
    return select ? WATER_PROFILES[select.value] || null : null;
};

// Message du solveur (ions impossibles à atteindre par ajout)
let solverNote = '';

// Remplir les champs avec les ajouts suggérés pour le profil sélectionné
const applySuggestedAdditions = () => {
    const profile = getSelectedProfile();
    const liters = parseFloat(document.getElementById('waterQuantity').value);
    if (!profile || !calculatorBaseWater || !(liters > 0)) return;

    const acid = document.getElementById('solverAcid').value || null;
    const grams = solveMineralAdditions(calculatorBaseWater, profile.ions, liters, { acid });
    MINERAL_INPUT_IDS.forEach(id => {
        document.getElementById(id).value = grams[id] || 0;
    });

    // Signaler les ions que les ajouts ne peuvent pas faire baisser
    const result = calculateMineralAdditions(calculatorBaseWater, grams, liters);
    const tooHigh = PROFILE_IONS.filter(ion => result[ion] > Math.max(profile.ions[ion] * 1.15, profile.ions[ion] + 10));
    solverNote = tooHigh.length > 0
        ? `Au-dessus de la cible : ${tooHigh.map(ion => PARAMETERS_OF_INTEREST[ion].label).join(', ')}. Les ajouts ne peuvent pas réduire ces ions — diluez avec de l'eau osmosée ou déminéralisée`
            + (!acid && tooHigh.includes('HCO3') ? ', ou choisissez un acide pour neutraliser les bicarbonates.' : '.')
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
const readSelectionLabels = () => ({
    communeCode: currentSelection.commune || '',
    communeName: currentSelection.communeName || '',
    networkCode: currentSelection.reseau || '',
    networkName: currentSelection.networkName || ''
});

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
        .map(id => `${mineralLabel(id)} : ${formatValue(state.additions[id])} ${SALT_UNITS[id]}`)
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

    appendText(sheet, 'h2', 'Ajouts (sels et acide)');
    const salts = MINERAL_INPUT_IDS.filter(id => state.additions[id] > 0);
    if (salts.length > 0) {
        appendTable(sheet, ['Ajout', 'Quantité'], salts.map(id => [mineralLabel(id), `${formatValue(state.additions[id])} ${SALT_UNITS[id]}`]));
    } else {
        appendText(sheet, 'p', 'Aucun ajout.');
    }

    appendText(sheet, 'h2', 'Composition (mg/L)');
    appendTable(sheet,
        ['Paramètre', 'Eau de base', 'Eau modifiée', ...(state.profile ? [`Cible ${state.profile.name}`] : [])],
        PROFILE_IONS.map(ion => [
            PARAMETERS_OF_INTEREST[ion].label,
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
    updateCalculations();
};

// Attacher les écouteurs du calculateur une seule fois
function initializeCalculator() {
    if (calculatorInitialized) return;
    renderSaltInputs();

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
                profileDescription.textContent = profile
                    ? `${profile.description} — valeurs indicatives.`
                    : 'Choisissez un profil pour comparer votre eau et obtenir une suggestion de sels.';
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

    document.getElementById('waterQuantity').addEventListener('input', updateCalculations);
    document.getElementById('resetAdditions').addEventListener('click', () => {
        MINERAL_INPUT_IDS.forEach(id => { document.getElementById(id).value = '0'; });
        solverNote = '';
        updateCalculations();
    });

    calculatorInitialized = true;
}

// Mettre à jour les eaux de base du calculateur ({ derniere, moyenne, maximum })
function updateCalculator(baseWaters) {
    calculatorBaseWaters = baseWaters;
    const baseWaterMode = document.getElementById('baseWaterMode');
    calculatorBaseWater = baseWaters[baseWaterMode ? baseWaterMode.value : 'derniere'];
    initializeCalculator();
    renderCalculator();
}

// Fonction pour cacher tous les résultats
function hideResults() {
    const elementsToHide = ['networkButtons', 'results'];
    elementsToHide.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.classList.add('hidden');
        }
    });
}

// Annonce pour les lecteurs d'écran (zone aria-live)
const announce = (message) => {
    const status = document.getElementById('status');
    if (status) status.textContent = message;
};

// Gestion des états de chargement : squelettes de cartes
const setLoading = (isLoading) => {
    const loadingElement = document.getElementById('loading');
    if (loadingElement) {
        loadingElement.classList.toggle('hidden', !isLoading);
    }
    announce(isLoading ? 'Chargement des analyses…' : '');
};

// Erreur affichée avec, si possible, une action « Réessayer »
let retryAction = null;

const showError = (message, retry = null) => {
    retryAction = retry;
    document.getElementById('errorMessage').textContent = message;
    document.getElementById('retryButton').classList.toggle('hidden', !retry);
    document.getElementById('error').classList.remove('hidden');
};

const hideError = () => {
    retryAction = null;
    document.getElementById('error').classList.add('hidden');
    document.getElementById('errorMessage').textContent = '';
};

// Vérifier si le backend SISE-Eaux est disponible
let siseAvailable = null;
let siseLastCheck = 0;
let siseLastSync = null;
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
            siseLastSync = health.last_sync;
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

// Pied de page : date de la dernière synchronisation SISE-Eaux
const updateSyncInfo = async () => {
    if (!(await checkSiseBackend()) || !siseLastSync) return;
    const date = luxon.DateTime.fromISO(siseLastSync).setLocale('fr').toLocaleString({ day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('syncInfo').textContent = ` (SISE-Eaux synchronisé le ${date})`;
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
        // Toutes les sources en échec : panne réseau, pas absence de données
        if (!hubEauData && !siseData) throw new Error('Aucune source joignable');

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
            showError('Aucune analyse publiée pour cette commune.');
            return;
        }

        const networks = Array.from(uniqueNetworks.values())
            .sort((a, b) => a.name.localeCompare(b.name));

        displayNetworks(networks);
    } catch (error) {
        if (requestId !== currentRequestId) return;
        showError('Les réseaux de cette commune n\'ont pas pu être chargés.', () => loadAnalyses(communeCode));
        console.error(error);
    } finally {
        if (requestId === currentRequestId) setLoading(false);
    }
};

// Chargement des analyses pour un réseau — fusionne Hub'Eau et SISE-Eaux
const loadNetworkAnalyses = async (networkCode) => {
    const requestId = ++currentRequestId;
    try {
        document.getElementById('results').classList.add('hidden');
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
        if (!hubEauData && !siseData) throw new Error('Aucune source joignable');

        const analyses = mergeAnalyses([
            { data: siseData, source: DATA_SOURCES.SISE_EAUX },
            { data: hubEauData, source: DATA_SOURCES.HUBEAU }
        ]);
        debug(`Analyses fusionnées : ${analyses.length} (Hub'Eau ${hubEauData?.data?.length ?? 0}, SISE ${siseData?.data?.length ?? 0})`);

        if (analyses.length === 0) {
            showError('Aucune analyse disponible pour ce réseau.', () => loadNetworkAnalyses(networkCode));
            return;
        }

        displayAnalyses(analyses);
    } catch (error) {
        if (requestId !== currentRequestId) return;
        showError('Les analyses de ce réseau n\'ont pas pu être chargées.', () => loadNetworkAnalyses(networkCode));
        console.error(error);
    } finally {
        if (requestId === currentRequestId) setLoading(false);
    }
};

// Styles des boutons de réseau (sélectionné ou non)
const NETWORK_BUTTON_BASE = 'px-5 py-3 rounded-xl border font-medium transition-all focus:outline-none focus:ring-2 focus:ring-sky-500/60';
const NETWORK_BUTTON_IDLE = 'bg-slate-800/80 text-slate-200 border-slate-600 hover:border-sky-500 hover:text-white';
const NETWORK_BUTTON_ACTIVE = 'bg-sky-600 text-white border-sky-500 shadow-lg shadow-sky-500/20';

const selectNetwork = (button, network) => {
    document.querySelectorAll('#networkButtons button').forEach(btn => {
        btn.setAttribute('aria-pressed', 'false');
        btn.className = `${NETWORK_BUTTON_BASE} ${NETWORK_BUTTON_IDLE}`;
    });
    button.setAttribute('aria-pressed', 'true');
    button.className = `${NETWORK_BUTTON_BASE} ${NETWORK_BUTTON_ACTIVE}`;

    currentSelection = { ...currentSelection, reseau: network.code, networkName: network.name };
    saveSelection(currentSelection);
    loadNetworkAnalyses(network.code);
};

// Affichage des réseaux disponibles ; un réseau unique est sélectionné automatiquement
const displayNetworks = (networks) => {
    const section = document.getElementById('networkButtons');
    const list = document.getElementById('networkList');
    list.innerHTML = '';
    document.getElementById('networkHint').textContent = networks.length > 1
        ? 'Votre commune est desservie par plusieurs réseaux : choisissez celui de votre quartier.'
        : 'Réseau qui dessert votre commune :';

    const buttons = networks.map(network => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${NETWORK_BUTTON_BASE} ${NETWORK_BUTTON_IDLE}`;
        button.setAttribute('aria-pressed', 'false');
        button.textContent = network.name;
        button.dataset.networkCode = network.code;
        button.addEventListener('click', () => selectNetwork(button, network));
        list.appendChild(button);
        return button;
    });

    section.classList.remove('hidden');
    if (buttons.length === 1) buttons[0].click();
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
            { text: item.message, color: QUALITY_LEVEL_COLORS[item.level], icon: QUALITY_LEVEL_ICONS[item.level] },
            item.title === 'Chlore' ? 'chlore' : null
        ));
    });
    section.classList.toggle('hidden', items.length === 0);
};

// Mesures des 12 mois précédant la dernière (ordre chronologique)
const lastYear = (analyses) => {
    const since = analyses[0].date.minus({ months: 12 });
    return analyses.filter(a => a.date >= since).slice().reverse();
};

// Mini-courbe SVG des 12 derniers mois
const SVG_NS = 'http://www.w3.org/2000/svg';
const createSparkline = (points) => {
    if (points.length < 2) return null;
    const values = points.map(p => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const start = points[0].date.toMillis();
    const span = points[points.length - 1].date.toMillis() - start || 1;
    const coords = points.map(p => {
        const x = (p.date.toMillis() - start) / span * 100;
        const y = max === min ? 12 : 22 - (p.value - min) / (max - min) * 20;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 24');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'hidden sm:block w-full h-8 text-sky-400 mt-3');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', coords);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);
    return svg;
};

// Jauge : repère brassage, étendue sur 12 mois et dernière valeur
const createGauge = (name, analyses, stats) => {
    const info = PARAMETERS_OF_INTEREST[name];
    const last = analyses[0].value;
    const scale = gaugeScale(name, [stats.min, stats.max, last]);
    const fmt = (v) => formatValue(Math.round(v * 100) / 100);

    const wrapper = document.createElement('div');
    wrapper.className = 'mt-3';
    const bar = document.createElement('div');
    bar.className = 'relative h-2 rounded-full bg-slate-700/70';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `Dernière valeur ${fmt(last)} ${info.unit}`
        + (stats.n > 1 ? `, de ${fmt(stats.min)} à ${fmt(stats.max)} sur 12 mois` : '')
        + (info.range ? `, repère brassage ${fmt(info.range.min)} à ${fmt(info.range.max)}` : ''));

    const segment = (from, to, className) => {
        const el = document.createElement('div');
        const left = gaugePosition(from, scale);
        el.className = `absolute top-0 h-2 rounded-full ${className}`;
        el.style.left = `${left}%`;
        el.style.width = `${Math.max(gaugePosition(to, scale) - left, 1)}%`;
        bar.appendChild(el);
    };
    if (info.range) segment(info.range.min, info.range.max, 'bg-emerald-500/30');
    if (stats.n > 1) segment(stats.min, stats.max, 'bg-sky-400/60');
    const marker = document.createElement('div');
    marker.className = 'absolute -top-1 h-4 w-1 -ml-0.5 rounded-full bg-white shadow';
    marker.style.left = `${gaugePosition(last, scale)}%`;
    bar.appendChild(marker);

    const legend = document.createElement('p');
    legend.className = 'mt-2 text-xs text-slate-400 flex flex-wrap gap-x-3 gap-y-1';
    if (stats.n > 1) {
        const range12 = document.createElement('span');
        range12.textContent = `12 mois : ${fmt(stats.min)} – ${fmt(stats.max)} (moy. ${fmt(stats.avg)})`;
        legend.appendChild(range12);
    }
    if (info.range) {
        const ref = document.createElement('span');
        ref.className = 'inline-flex items-center gap-1';
        const swatch = document.createElement('span');
        swatch.className = 'inline-block w-3 h-2 rounded-sm bg-emerald-500/40';
        const text = document.createElement('span');
        text.textContent = `repère brassage ${fmt(info.range.min)}–${fmt(info.range.max)}`;
        ref.append(swatch, text);
        legend.appendChild(ref);
    }
    wrapper.append(bar, legend);
    return wrapper;
};

// Créer la carte d'un paramètre : valeur, mini-courbe, jauge, source
const createParameterCard = (name, label, analyses) => {
    const info = PARAMETERS_OF_INTEREST[name];
    const lastAnalysis = analyses[0];
    const stats = computeYearStats(analyses);

    const card = document.createElement('article');
    card.className = 'p-5 rounded-2xl bg-slate-800/40 border border-slate-700/50';

    const header = document.createElement('div');
    header.className = 'flex items-baseline justify-between gap-2';
    const h3 = document.createElement('h3');
    h3.className = 'text-base font-semibold text-slate-200';
    h3.textContent = label;
    header.appendChild(h3);
    if (info.symbol) {
        const symbol = document.createElement('span');
        symbol.className = 'text-sm text-slate-400 font-mono';
        symbol.textContent = info.symbol;
        header.appendChild(symbol);
    }

    const valueP = document.createElement('p');
    valueP.className = 'mt-2 text-3xl font-bold text-white';
    valueP.textContent = formatValue(lastAnalysis.value) + ' ';
    const unitSpan = document.createElement('span');
    unitSpan.className = 'text-sm text-slate-400 font-normal';
    unitSpan.textContent = info.unit;
    valueP.appendChild(unitSpan);

    card.append(header, valueP);
    const sparkline = createSparkline(lastYear(analyses));
    if (sparkline) card.appendChild(sparkline);
    // Jauge utile s'il y a un repère, une échelle fixe ou une variation à montrer
    if (info.range || info.scale || stats.n > 1) card.appendChild(createGauge(name, analyses, stats));

    // Source et date, discrètes
    const source = document.createElement('p');
    source.className = 'mt-3 text-xs text-slate-400 flex items-center gap-1.5';
    const icon = document.createElement('i');
    icon.className = `${lastAnalysis.source.icon} text-slate-400`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const date = lastAnalysis.date.setLocale('fr').toLocaleString({ day: 'numeric', month: 'short', year: 'numeric' });
    text.textContent = `${lastAnalysis.source.name} · ${date}`;
    source.append(icon, text);
    card.appendChild(source);

    return card;
};

// Phrase de synthèse en tête de l'onglet « Mon eau »
const displayWaterSummary = (water, qualityItems) => {
    const container = document.getElementById('waterSummary');
    if (!container) return;
    const { headline, details } = summarizeWater(water, qualityItems);
    container.innerHTML = '';
    appendText(container, 'p', headline, 'text-lg md:text-xl font-semibold text-white');
    if (details.length > 0) {
        const list = document.createElement('ul');
        list.className = 'mt-3 space-y-1 text-sm text-slate-300 list-disc pl-5';
        details.forEach(detail => appendText(list, 'li', detail));
        container.appendChild(list);
    }
};

// Affichage des dernières valeurs
const displayCurrentValues = (parameterGroups, labels, usedSources) => {
    const grid = document.getElementById('parameterCards');
    if (!grid) return;
    grid.innerHTML = '';

    Object.entries(parameterGroups).forEach(([name, analyses]) => {
        if (analyses.length === 0) return;
        grid.appendChild(createParameterCard(name, labels[name], analyses));
    });

    document.getElementById('results').classList.remove('hidden');

    // Bandeau global de source et fraîcheur des données
    displayDataSourceBanner(parameterGroups, usedSources);

    // Eaux de base du calculateur (paramètres absents à 0)
    const baseWaters = buildBaseWaters(parameterGroups);
    updateCalculator(baseWaters);

    // Indicateurs brassicoles de l'eau du réseau (dernière mesure)
    const brewingIndicators = document.getElementById('brewingIndicators');
    if (brewingIndicators) {
        renderBrewingIndicators(brewingIndicators.querySelector('.grid'), baseWaters.derniere);
        displayWaterSummary(baseWaters.derniere, currentReport ? currentReport.qualityItems : []);
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
        noteLine.className = 'flex items-center gap-3 ml-7 text-slate-400 text-xs';
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

// --- Historique : un graphique, un paramètre et une période à la fois ---

const historyState = { groups: null, labels: null, param: 'CALCIUM (CA)', period: '3ans' };
let historyChart = null;

// Couleurs des axes adaptées au thème sombre
const CHART_TEXT_COLOR = 'rgb(148, 163, 184)'; // slate-400
const CHART_GRID_COLOR = 'rgba(148, 163, 184, 0.12)';

// Plugin local : bande du repère brassage, limitée à la zone visible de l'axe Y
const brewingRangePlugin = {
    id: 'brewingRange',
    beforeDatasetsDraw(chart, args, options) {
        const range = options && options.range;
        const y = chart.scales.y;
        if (!range || range.min > y.max || range.max < y.min) return;
        const top = y.getPixelForValue(Math.min(range.max, y.max));
        const bottom = y.getPixelForValue(Math.max(range.min, y.min));
        const { left, right } = chart.chartArea;
        chart.ctx.save();
        chart.ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
        chart.ctx.fillRect(left, top, right - left, bottom - top);
        chart.ctx.restore();
    }
};

// Bouton bascule (pastille de paramètre ou de période)
const createToggle = (text, pressed, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-button';
    button.setAttribute('aria-pressed', String(pressed));
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
};

const renderHistoryControls = () => {
    const params = document.getElementById('historyParams');
    params.innerHTML = '';
    Object.entries(historyState.groups)
        .filter(([, analyses]) => analyses.length > 0)
        .forEach(([name]) => {
            params.appendChild(createToggle(PARAMETERS_OF_INTEREST[name].label, name === historyState.param, () => {
                historyState.param = name;
                renderHistoryControls();
                renderHistoryChart();
            }));
        });

    const periods = document.getElementById('historyPeriods');
    periods.innerHTML = '';
    Object.entries(HISTORY_PERIODS).forEach(([id, period]) => {
        periods.appendChild(createToggle(period.label, id === historyState.period, () => {
            historyState.period = id;
            renderHistoryControls();
            renderHistoryChart();
        }));
    });
};

const renderHistoryChart = () => {
    const name = historyState.param;
    const info = PARAMETERS_OF_INTEREST[name];
    const label = historyState.labels[name];
    const points = filterByPeriod(historyState.groups[name] || [], historyState.period);
    const color = (PARAMETER_COLORS[name] || PARAMETER_COLORS['CALCIUM (CA)']).color;
    const fmt = (v) => formatValue(Math.round(v * 100) / 100);

    // Résumé textuel (aussi utilisé comme description du graphique)
    const values = points.map(p => p.value);
    const summary = points.length === 0
        ? `${label} : aucune mesure sur la période.`
        : `${label} : ${points.length} mesure${points.length > 1 ? 's' : ''}, de ${fmt(Math.min(...values))} à ${fmt(Math.max(...values))} ${info.unit}.`;
    const canvas = document.getElementById('historyChart');
    // Classe (et non attribut) hidden : l'attribut serait écrasé par la classe inline-flex
    document.getElementById('historyComputedLegend').classList.toggle('hidden', !points.some(p => p.source === CALCULATED_SOURCE));

    // Repère brassage : bande dans le graphique, ou mention textuelle s'il est hors de l'échelle
    const describeRange = (yMax) => {
        const visible = info.range && points.length > 0 && info.range.min <= yMax;
        document.getElementById('historyRangeLegend').classList.toggle('hidden', !visible);
        const text = info.range && !visible && points.length > 0 && info.range.min > Math.max(...values)
            ? `${summary} Repère brassage ${fmt(info.range.min)}–${fmt(info.range.max)} ${info.unit} : au-dessus des valeurs mesurées.`
            : summary;
        document.getElementById('historySummary').textContent = text;
        canvas.setAttribute('aria-label', `Évolution — ${text}`);
    };

    const data = points.map(p => ({ x: p.date.toJSDate(), y: p.value, source: p.source.name, computed: p.source === CALCULATED_SOURCE }));
    const dataset = {
        label,
        data,
        borderColor: color,
        borderWidth: 2,
        tension: 0, // lignes droites : aucune valeur inventée entre deux mesures
        pointRadius: data.length > 100 ? 2 : 3,
        pointHoverRadius: 6,
        pointBorderColor: color,
        pointBackgroundColor: (ctx) => (ctx.raw && ctx.raw.computed ? 'rgba(15, 23, 42, 1)' : color),
        fill: false
    };
    const yScale = info.scale
        ? { min: info.scale.min, max: info.scale.max }
        : { beginAtZero: true, min: undefined, max: undefined };

    if (!historyChart) {
        historyChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { datasets: [dataset] },
            plugins: [brewingRangePlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300 },
                interaction: { mode: 'nearest', intersect: false },
                plugins: {
                    legend: { display: false },
                    brewingRange: { range: info.range || null },
                    tooltip: {
                        callbacks: {
                            title: (items) => luxon.DateTime.fromJSDate(items[0].raw.x).setLocale('fr')
                                .toLocaleString({ day: 'numeric', month: 'long', year: 'numeric' }),
                            label: (item) => `${formatValue(Math.round(item.raw.y * 100) / 100)} ${PARAMETERS_OF_INTEREST[historyState.param].unit} — ${item.raw.source}`
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        adapters: { date: { locale: 'fr' } },
                        time: { displayFormats: { month: 'MMM yyyy', quarter: 'MMM yyyy', year: 'yyyy' } },
                        ticks: { color: CHART_TEXT_COLOR, maxRotation: 0, autoSkipPadding: 16 },
                        grid: { color: CHART_GRID_COLOR }
                    },
                    y: {
                        ...yScale,
                        title: { display: true, text: info.unit, color: CHART_TEXT_COLOR },
                        ticks: { color: CHART_TEXT_COLOR },
                        grid: { color: CHART_GRID_COLOR }
                    }
                }
            }
        });
    } else {
        historyChart.data.datasets = [dataset];
        historyChart.options.plugins.brewingRange.range = info.range || null;
        Object.assign(historyChart.options.scales.y, yScale);
        historyChart.options.scales.y.title.text = info.unit;
        historyChart.update();
    }
    describeRange(historyChart.scales.y.max);
};

// Affichage de l'historique pour le réseau courant
const displayCharts = (parameterGroups, labels) => {
    historyState.groups = parameterGroups;
    historyState.labels = labels;
    if (!parameterGroups[historyState.param] || parameterGroups[historyState.param].length === 0) {
        historyState.param = Object.keys(parameterGroups).find(name => parameterGroups[name].length > 0);
    }
    if (!historyState.param) return;
    renderHistoryControls();
    renderHistoryChart();
};

// Démarrer l'application
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
