// Fonction de debug désactivée en production pour éviter la fuite d'informations
function debug(message) {
    // No-op en production. Décommenter la ligne suivante pour le développement :
    // console.log(message);
}

// Fonction pour attendre que le DOM soit prêt
function waitForElement(selector, callback, maxAttempts = 50) {
    let attempts = 0;

    const checkElement = () => {
        attempts++;
        const element = document.querySelector(selector);

        if (element) {
            debug(`Element ${selector} found after ${attempts} attempts`);
            callback(element);
            return;
        }

        if (attempts < maxAttempts) {
            setTimeout(checkElement, 100);
        } else {
            const error = `Element ${selector} not found after ${maxAttempts} attempts`;
            console.error(error);
            debug(error);
        }
    };

    checkElement();
}

// Fonction pour attendre que tout soit chargé
function waitForDOM(callback, maxAttempts = 10) {
    let attempts = 0;

    function checkElements() {
        attempts++;
        debug(`Attempt ${attempts} to find DOM elements`);

        const elements = {
            departementSelect: document.getElementById('departementSelect'),
            communeSelect: document.getElementById('communeSelect'),
            networkButtons: document.getElementById('networkButtons'),
            currentParameters: document.getElementById('currentParameters'),
            charts: document.getElementById('charts'),
            chartsGrid: document.getElementById('chartsGrid'),
            loading: document.getElementById('loading'),
            error: document.getElementById('error')
        };

        const missingElements = Object.entries(elements)
            .filter(([_, element]) => !element)
            .map(([name]) => name);

        if (missingElements.length === 0) {
            debug('All elements found successfully');
            callback(elements);
            return;
        }

        if (attempts < maxAttempts) {
            debug(`Missing elements: ${missingElements.join(', ')}. Retrying...`);
            setTimeout(checkElements, 200);
        } else {
            const error = `Failed to find elements after ${maxAttempts} attempts: ${missingElements.join(', ')}`;
            console.error(error);
            debug(error);
        }
    }

    checkElements();
}

// Fonction principale de l'application
function initApp() {
    // Attendre que les éléments soient disponibles
    waitForElement('#departementSelect', (departementSelect) => {
        waitForElement('#communeSelect', (communeSelect) => {
            // Configuration des événements
            departementSelect.addEventListener('change', (e) => {
                loadCommunes(e.target.value);
                hideResults();
            });

            communeSelect.addEventListener('change', (e) => {
                if (e.target.value) {
                    loadAnalyses(e.target.value);
                    hideResults();
                } else {
                    hideResults();
                }
            });

            // Charger les départements
            loadDepartements();
        });
    });
}

// Paramètres d'intérêt pour la bière
const PARAMETERS_OF_INTEREST = {
    'CALCIUM (CA)': { code: '1374', unit: 'mg/L', target: { min: 50, max: 150 } },
    'MAGNESIUM (MG)': { code: '1372', unit: 'mg/L', target: { min: 10, max: 30 } },
    'SODIUM (NA)': { code: '1375', unit: 'mg/L', target: { min: 0, max: 150 } },
    'SULFATES (SO4)': { code: '1338', unit: 'mg/L', target: { min: 50, max: 350 } },
    'CHLORURES': { code: '1337', unit: 'mg/L', target: { min: 0, max: 250 } },
    'POTASSIUM (K)': { code: '1367', unit: 'mg/L', target: { min: 0, max: 10 } },
    'PH': { code: '1302', unit: 'unité pH', target: { min: 5.2, max: 8.8 } },
    'TAC': { code: '1347', unit: '°f', target: { min: 0, max: 400 } },
    'HCO3': { code: 'HCO3', unit: 'mg/L', target: { min: 0, max: 400 } }
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
    calciumChloride: { // CaCl2·2H2O (77%)
        ca: 0.2772, // 27.72% de calcium
        cl: 0.4925  // 49.25% de chlorure
    },
    sodiumChloride: { // NaCl (Sel de table)
        na: 0.3934, // 39.34% de sodium
        cl: 0.6066  // 60.66% de chlorure
    },
    calciumCarbonate: { // CaCO3 (Craie)
        ca: 0.4004, // 40.04% de calcium
        hco3: 0.9756 // Conversion en équivalent HCO3
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

// Fonction pour calculer les concentrations après ajout de minéraux
function calculateMineralAdditions(baseWater, additions, waterQuantity) {
    const result = { ...baseWater };
    const liters = parseFloat(waterQuantity);

    // Fonction pour ajouter un minéral aux résultats
    const addMineral = (amount, mineral, conversions) => {
        for (const [element, percentage] of Object.entries(conversions)) {
            const addedAmount = (amount * percentage * 1000) / liters; // Conversion g -> mg/L
            switch (element) {
                case 'ca':
                    result['CALCIUM (CA)'] = (result['CALCIUM (CA)'] || 0) + addedAmount;
                    break;
                case 'mg':
                    result['MAGNESIUM (MG)'] = (result['MAGNESIUM (MG)'] || 0) + addedAmount;
                    break;
                case 'na':
                    result['SODIUM (NA)'] = (result['SODIUM (NA)'] || 0) + addedAmount;
                    break;
                case 'k':
                    result['POTASSIUM (K)'] = (result['POTASSIUM (K)'] || 0) + addedAmount;
                    break;
                case 'so4':
                    result['SULFATES (SO4)'] = (result['SULFATES (SO4)'] || 0) + addedAmount;
                    break;
                case 'cl':
                    result['CHLORURES'] = (result['CHLORURES'] || 0) + addedAmount;
                    break;
                case 'hco3':
                    result['HCO3'] = (result['HCO3'] || 0) + addedAmount;
                    break;
            }
        }
    };

    // Ajouter chaque minéral
    if (additions.calciumSulfate > 0) {
        addMineral(additions.calciumSulfate, 'calciumSulfate', MINERAL_CONVERSIONS.calciumSulfate);
    }
    if (additions.magnesiumSulfate > 0) {
        addMineral(additions.magnesiumSulfate, 'magnesiumSulfate', MINERAL_CONVERSIONS.magnesiumSulfate);
    }
    if (additions.calciumChloride > 0) {
        addMineral(additions.calciumChloride, 'calciumChloride', MINERAL_CONVERSIONS.calciumChloride);
    }
    if (additions.sodiumChloride > 0) {
        addMineral(additions.sodiumChloride, 'sodiumChloride', MINERAL_CONVERSIONS.sodiumChloride);
    }
    if (additions.calciumCarbonate > 0) {
        addMineral(additions.calciumCarbonate, 'calciumCarbonate', MINERAL_CONVERSIONS.calciumCarbonate);
    }
    if (additions.sodiumBicarbonate > 0) {
        addMineral(additions.sodiumBicarbonate, 'sodiumBicarbonate', MINERAL_CONVERSIONS.sodiumBicarbonate);
    }
    if (additions.potassiumChloride > 0) {
        addMineral(additions.potassiumChloride, 'potassiumChloride', MINERAL_CONVERSIONS.potassiumChloride);
    }

    return result;
}

// Fonction pour mettre à jour l'affichage du calculateur
function updateCalculator(baseWater) {
    const waterCalculator = document.getElementById('waterCalculator');
    const openCalculatorBtn = document.getElementById('openCalculator');
    if (!waterCalculator || !openCalculatorBtn) return;

    // Cacher le calculateur initialement
    waterCalculator.classList.add('hidden');

    // Supprimer l'ancien écouteur d'événement s'il existe
    const oldListener = openCalculatorBtn._calculatorListener;
    if (oldListener) {
        openCalculatorBtn.removeEventListener('click', oldListener);
    }

    // Créer et stocker le nouvel écouteur
    const newListener = () => {
        waterCalculator.classList.toggle('hidden');
        if (!waterCalculator.classList.contains('hidden')) {
            // Initialiser le calculateur seulement quand il est ouvert
            initializeCalculator(baseWater);
        }
    };
    openCalculatorBtn._calculatorListener = newListener;

    // Ajouter le nouvel écouteur
    openCalculatorBtn.addEventListener('click', newListener);
}

// Fonction pour initialiser le calculateur
function initializeCalculator(baseWater) {
    const waterCalculator = document.getElementById('waterCalculator');
    if (!waterCalculator) return;

    // Afficher les paramètres de base
    const baseWaterParams = document.getElementById('baseWaterParams');
    const modifiedWaterParams = document.getElementById('modifiedWaterParams');

    // Fonction pour créer l'affichage des paramètres (sécurisé contre XSS)
    const createParameterDisplay = (value, unit, target) => {
        const isInRange = value >= target.min && value <= target.max;
        const span = document.createElement('span');
        span.className = isInRange ? 'text-green-600' : 'text-red-600';
        span.textContent = `${value.toFixed(1)} ${unit}`;
        return span;
    };

    // Afficher les paramètres initiaux (sécurisé contre XSS - pas de innerHTML)
    const displayParameters = (container, water) => {
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

    // Afficher l'eau de base
    displayParameters(baseWaterParams, baseWater);

    // Fonction pour mettre à jour les calculs
    const updateCalculations = () => {
        const waterQuantity = document.getElementById('waterQuantity').value;
        const additions = {
            calciumSulfate: parseFloat(document.getElementById('calciumSulfate').value) || 0,
            magnesiumSulfate: parseFloat(document.getElementById('magnesiumSulfate').value) || 0,
            calciumChloride: parseFloat(document.getElementById('calciumChloride').value) || 0,
            sodiumChloride: parseFloat(document.getElementById('sodiumChloride').value) || 0,
            calciumCarbonate: parseFloat(document.getElementById('calciumCarbonate').value) || 0,
            sodiumBicarbonate: parseFloat(document.getElementById('sodiumBicarbonate').value) || 0,
            potassiumChloride: parseFloat(document.getElementById('potassiumChloride').value) || 0
        };

        const modifiedWater = calculateMineralAdditions(baseWater, additions, waterQuantity);
        displayParameters(modifiedWaterParams, modifiedWater);
    };

    // Ajouter les événements pour les mises à jour en direct
    const waterQuantityInput = document.getElementById('waterQuantity');
    if (waterQuantityInput) {
        waterQuantityInput.addEventListener('input', updateCalculations);
    }

    // Liste des IDs des inputs de minéraux
    const mineralInputIds = [
        'calciumSulfate',
        'magnesiumSulfate',
        'calciumChloride',
        'sodiumChloride',
        'calciumCarbonate',
        'sodiumBicarbonate',
        'potassiumChloride'
    ];

    // Ajouter les événements à chaque input de minéral
    mineralInputIds.forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', updateCalculations);
        }
    });

    // Calculer les valeurs initiales
    updateCalculations();
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

// Formatage des dates
const formatDate = (dateStr) => {
    return luxon.DateTime.fromISO(dateStr).toLocaleString({ locale: 'fr' });
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

        departements.sort((a, b) => parseInt(a.code) - parseInt(b.code));
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

// Chargement des analyses d'eau
const loadAnalyses = async (communeCode) => {
    try {
        setLoading(true);
        hideError();

        const response = await fetch(`https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/communes_udi?code_commune=${encodeURIComponent(communeCode)}&size=100`, {
            headers: {
                'Accept': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!data || typeof data.count === 'undefined' || !Array.isArray(data.data)) {
            throw new Error('Format de réponse invalide');
        }

        if (data.count === 0) {
            showError('Aucune donnée disponible pour cette commune');
            return;
        }

        // Dédoublonnage des réseaux
        const uniqueNetworks = new Map();
        data.data.forEach(item => {
            if (!uniqueNetworks.has(item.code_reseau)) {
                uniqueNetworks.set(item.code_reseau, {
                    code: item.code_reseau,
                    name: item.nom_reseau
                });
            }
        });

        const networks = Array.from(uniqueNetworks.values())
            .sort((a, b) => a.name.localeCompare(b.name));

        displayNetworks(networks);
    } catch (error) {
        showError('Erreur lors du chargement des réseaux');
        console.error(error);
    } finally {
        setLoading(false);
    }
};

// Chargement des analyses pour un réseau spécifique
const loadNetworkAnalyses = async (networkCode) => {
    try {
        setLoading(true);
        hideError();

        const paramCodes = Object.values(PARAMETERS_OF_INTEREST).map(p => p.code).join(',');
        const response = await fetch(`https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_reseau=${encodeURIComponent(networkCode)}&code_parametre=${encodeURIComponent(paramCodes)}&size=5000`, {
            headers: {
                'Accept': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!data || typeof data.count === 'undefined' || !Array.isArray(data.data)) {
            throw new Error('Format de réponse invalide');
        }

        if (data.count === 0) {
            showError('Aucune analyse disponible pour ce réseau');
            return;
        }

        displayAnalyses(data.data);
    } catch (error) {
        showError('Erreur lors du chargement des analyses');
        console.error(error);
    } finally {
        setLoading(false);
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

// Affichage des analyses
const displayAnalyses = (analyses) => {
    // Regrouper les analyses par paramètre
    const parameterGroups = {};
    Object.entries(PARAMETERS_OF_INTEREST).forEach(([name, info]) => {
        parameterGroups[name] = analyses.filter(a => a.code_parametre === info.code)
            .sort((a, b) => {
                const dateA = luxon.DateTime.fromISO(a.date_prelevement);
                const dateB = luxon.DateTime.fromISO(b.date_prelevement);
                return dateB - dateA;
            });
    });

    // Afficher les dernières valeurs
    displayCurrentValues(parameterGroups);

    // Afficher les graphiques
    displayCharts(parameterGroups);
};

// Affichage des dernières valeurs
const displayCurrentValues = (parameterGroups) => {
    const container = document.getElementById('currentParameters');
    if (container) {
        const grid = container.querySelector('.grid');
        if (grid) {
            grid.innerHTML = '';
        }
    }

    const currentValues = {};
    Object.entries(parameterGroups).forEach(([name, analyses]) => {
        if (analyses.length === 0) return;

        // Créer une carte pour chaque paramètre
        const card = document.createElement('div');
        // card.className = 'bg-white p-4 rounded-lg shadow'; // OLD
        card.className = 'bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50 backdrop-blur-sm hover:border-sky-500/50 transition-colors group';

        const lastAnalysis = analyses[0];

        // Construction sécurisée du DOM (pas de innerHTML avec des données API)
        const header = document.createElement('div');
        header.className = 'flex justify-between items-start mb-4';
        const h3 = document.createElement('h3');
        h3.className = 'text-lg font-semibold text-slate-300 group-hover:text-sky-400 transition-colors';
        h3.textContent = name;
        const iconDiv = document.createElement('div');
        iconDiv.className = 'p-2 rounded-lg bg-slate-700/30 text-sky-500';
        const icon = document.createElement('i');
        icon.className = 'fas fa-atom';
        iconDiv.appendChild(icon);
        header.appendChild(h3);
        header.appendChild(iconDiv);

        const valueP = document.createElement('p');
        valueP.className = 'text-3xl font-bold text-white mb-2';
        valueP.textContent = lastAnalysis.resultat_numerique + ' ';
        const unitSpan = document.createElement('span');
        unitSpan.className = 'text-sm text-slate-500 font-normal ml-1';
        unitSpan.textContent = PARAMETERS_OF_INTEREST[name].unit;
        valueP.appendChild(unitSpan);

        const dateP = document.createElement('p');
        dateP.className = 'text-xs text-slate-500 mt-2 flex items-center gap-1';
        const clockIcon = document.createElement('i');
        clockIcon.className = 'far fa-clock';
        dateP.appendChild(clockIcon);
        dateP.appendChild(document.createTextNode(' ' + formatDate(lastAnalysis.date_prelevement)));

        card.appendChild(header);
        card.appendChild(valueP);
        card.appendChild(dateP);

        const container = document.getElementById('currentParameters');
        if (container) {
            const grid = container.querySelector('.grid');
            if (grid) {
                grid.appendChild(card);
            }
        }

        currentValues[name] = lastAnalysis.resultat_numerique;
    });

    // Ajouter la carte HCO3 si le TAC est disponible
    const tacAnalyses = parameterGroups['TAC'];
    if (tacAnalyses && tacAnalyses.length > 0) {
        const lastTac = tacAnalyses[0];
        const hco3Value = calculateHCO3(lastTac.resultat_numerique);

        if (hco3Value !== null) {
            const card = document.createElement('div');
            card.className = 'bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50 backdrop-blur-sm hover:border-sky-500/50 transition-colors group';
            // Construction sécurisée du DOM (pas de innerHTML avec des données API)
            const hco3Header = document.createElement('div');
            hco3Header.className = 'flex justify-between items-start mb-4';
            const hco3H3 = document.createElement('h3');
            hco3H3.className = 'text-lg font-semibold text-slate-300 group-hover:text-sky-400 transition-colors';
            hco3H3.textContent = 'HCO3 (calculé)';
            const hco3IconDiv = document.createElement('div');
            hco3IconDiv.className = 'p-2 rounded-lg bg-slate-700/30 text-amber-500';
            const hco3Icon = document.createElement('i');
            hco3Icon.className = 'fas fa-calculator';
            hco3IconDiv.appendChild(hco3Icon);
            hco3Header.appendChild(hco3H3);
            hco3Header.appendChild(hco3IconDiv);

            const hco3ValueP = document.createElement('p');
            hco3ValueP.className = 'text-3xl font-bold text-white mb-2';
            hco3ValueP.textContent = hco3Value.toFixed(1) + ' ';
            const hco3UnitSpan = document.createElement('span');
            hco3UnitSpan.className = 'text-sm text-slate-500 font-normal ml-1';
            hco3UnitSpan.textContent = 'mg/L';
            hco3ValueP.appendChild(hco3UnitSpan);

            const hco3DateP = document.createElement('p');
            hco3DateP.className = 'text-xs text-slate-500 mt-2 flex items-center gap-1';
            const hco3ClockIcon = document.createElement('i');
            hco3ClockIcon.className = 'far fa-clock';
            hco3DateP.appendChild(hco3ClockIcon);
            hco3DateP.appendChild(document.createTextNode(' Calculé à partir du TAC du ' + formatDate(lastTac.date_prelevement)));

            card.appendChild(hco3Header);
            card.appendChild(hco3ValueP);
            card.appendChild(hco3DateP);
            const container = document.getElementById('currentParameters');
            if (container) {
                const grid = container.querySelector('.grid');
                if (grid) {
                    grid.appendChild(card);
                }
            }

            // Ajouter la valeur HCO3 aux currentValues avant de les passer au calculateur
            currentValues['HCO3'] = hco3Value;
        }
    }

    const currentParameters = document.getElementById('currentParameters');
    if (currentParameters) {
        currentParameters.classList.remove('hidden');
    }

    // S'assurer que toutes les valeurs sont définies avant de les passer au calculateur
    Object.keys(PARAMETERS_OF_INTEREST).forEach(key => {
        if (!(key in currentValues)) {
            currentValues[key] = 0;
        }
    });

    updateCalculator(currentValues);
};

// Affichage des graphiques
const displayCharts = (parameterGroups) => {
    const chartsGrid = document.getElementById('chartsGrid');
    if (chartsGrid) {
        chartsGrid.innerHTML = '';
    }

    Object.entries(parameterGroups).forEach(([name, analyses]) => {
        if (analyses.length === 0) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const data = analyses.map(a => ({
            x: luxon.DateTime.fromISO(a.date_prelevement).toJSDate(),
            y: a.resultat_numerique
        })).sort((a, b) => a.x - b.x);

        const color = PARAMETER_COLORS[name] || { color: 'rgb(59, 130, 246)', background: 'rgba(59, 130, 246, 0.1)' };
        new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: name,
                    data: data,
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
                        text: `${name} (${PARAMETERS_OF_INTEREST[name].unit})`,
                        font: {
                            size: 16,
                            weight: 'bold'
                        },
                        padding: 20
                    },
                    legend: {
                        display: false
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'month',
                            displayFormats: {
                                month: 'MMM yyyy'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Date',
                            font: {
                                weight: 'bold'
                            }
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: PARAMETERS_OF_INTEREST[name].unit,
                            font: {
                                weight: 'bold'
                            }
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    }
                }
            }
        });

        const wrapper = document.createElement('div');
        wrapper.className = 'bg-slate-800/40 p-6 rounded-2xl shadow-xl border border-slate-700/50 backdrop-blur-sm';
        wrapper.style.height = '400px';
        wrapper.appendChild(canvas);
        const chartsGrid = document.getElementById('chartsGrid');
        if (chartsGrid) {
            chartsGrid.appendChild(wrapper);
        }
    });

    // Ajouter le graphique HCO3 calculé si des données TAC sont disponibles
    if (parameterGroups['TAC'] && parameterGroups['TAC'].length > 0) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const data = parameterGroups['TAC'].map(a => ({
            x: luxon.DateTime.fromISO(a.date_prelevement).toJSDate(),
            y: calculateHCO3(a.resultat_numerique)
        })).sort((a, b) => a.x - b.x);

        const hco3Color = PARAMETER_COLORS['HCO3'];
        new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'HCO3 (calculé)',
                    data: data,
                    borderColor: hco3Color.color,
                    backgroundColor: hco3Color.background,
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 4,
                    pointBackgroundColor: hco3Color.color,
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
                        text: `HCO3 calculé (${PARAMETERS_OF_INTEREST['HCO3'].unit})`,
                        font: {
                            size: 16,
                            weight: 'bold'
                        },
                        padding: 20
                    },
                    legend: {
                        display: false
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'month',
                            displayFormats: {
                                month: 'MMM yyyy'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Date',
                            font: {
                                weight: 'bold'
                            }
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: PARAMETERS_OF_INTEREST['HCO3'].unit,
                            font: {
                                weight: 'bold'
                            }
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    }
                }
            }
        });

        const wrapper = document.createElement('div');
        wrapper.className = 'bg-slate-800/40 p-6 rounded-2xl shadow-xl border border-slate-700/50 backdrop-blur-sm';
        wrapper.style.height = '400px';
        wrapper.appendChild(canvas);
        const chartsGrid = document.getElementById('chartsGrid');
        if (chartsGrid) {
            chartsGrid.appendChild(wrapper);
        }
    }

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
