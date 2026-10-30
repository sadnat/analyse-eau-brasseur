// Tests de la logique métier (water.js) — exécutés avec `npm test` (node:test)
const { test } = require('node:test');
const assert = require('node:assert/strict');

// water.js utilise luxon en global, comme dans le navigateur (CDN)
global.luxon = require('luxon');
const w = require('../water.js');

const approx = (actual, expected, tolerance, message) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message || ''} attendu ${expected} ± ${tolerance}, obtenu ${actual}`);

// --- Calculateur de minéraux ---

test('CaCl2·2H2O : 1 g dans 1 L apporte 272,6 mg/L de Ca et 482,3 mg/L de Cl', () => {
    const result = w.calculateMineralAdditions({}, { calciumChloride: 1 }, 1);
    approx(result['CALCIUM (CA)'], 272.6, 0.1);
    approx(result['CHLORURES'], 482.3, 0.1);
});

test('les ajouts se cumulent et sont rapportés au volume', () => {
    const base = { 'CALCIUM (CA)': 10, 'SULFATES (SO4)': 5 };
    const result = w.calculateMineralAdditions(base, { calciumSulfate: 2, calciumChloride: 1 }, 20);
    approx(result['CALCIUM (CA)'], 10 + (2 * 0.2324 + 0.2726) * 1000 / 20, 0.01);
    approx(result['SULFATES (SO4)'], 5 + 2 * 0.5570 * 1000 / 20, 0.01);
    assert.equal(base['CALCIUM (CA)'], 10, "l'eau de base n'est pas modifiée");
});

test('volume nul ou invalide : eau de base inchangée (pas de NaN/Infinity)', () => {
    const base = { 'CALCIUM (CA)': 10 };
    assert.deepEqual(w.calculateMineralAdditions(base, { calciumChloride: 1 }, 0), base);
    assert.deepEqual(w.calculateMineralAdditions(base, { calciumChloride: 1 }, ''), base);
});

test('sel inconnu ou quantité négative ignorés', () => {
    const base = { 'CALCIUM (CA)': 10 };
    assert.deepEqual(w.calculateMineralAdditions(base, { inconnu: 5, calciumChloride: -1 }, 10), base);
});

test('chaque sel ne contient que des éléments connus', () => {
    Object.values(w.MINERAL_CONVERSIONS).forEach(conversions => {
        Object.keys(conversions).forEach(element => assert.ok(w.ION_KEYS[element], element));
    });
});

// --- Calculs brassicoles ---

test('HCO3 depuis le TAC : 10 °f = 122 mg/L', () => {
    assert.equal(w.calculateHCO3(10), 122);
    assert.equal(w.calculateHCO3(null), null);
    assert.equal(w.calculateHCO3('abc'), null);
});

test('alcalinité résiduelle : Dublin ≈ 175, Pilsen ≈ 6 mg/L CaCO3', () => {
    approx(w.calculateResidualAlkalinity(w.WATER_PROFILES.dublin.ions), 175, 2);
    approx(w.calculateResidualAlkalinity(w.WATER_PROFILES.pilsen.ions), 6, 2);
});

test('ratio SO4/Cl : null sans chlorures', () => {
    assert.equal(w.calculateSulfateChlorideRatio({ 'SULFATES (SO4)': 10 }), null);
    assert.equal(w.calculateSulfateChlorideRatio({ 'SULFATES (SO4)': 100, 'CHLORURES': 50 }), 2);
});

test('balance ionique : NaCl pur équilibré, eau vide sans résultat', () => {
    const balance = w.calculateIonBalance({ 'SODIUM (NA)': 22.99, 'CHLORURES': 35.45 });
    approx(balance.error, 0, 0.01);
    assert.equal(w.calculateIonBalance({}), null);
});

test('interprétations aux seuils', () => {
    assert.match(w.describeResidualAlkalinity(-10).text, /pâles/);
    assert.match(w.describeResidualAlkalinity(100).text, /brunes/);
    assert.equal(w.describeSulfateChlorideRatio(1).text, 'Équilibré');
    assert.match(w.describeIonBalance({ error: 20 }).text, /incomplète/);
});

test('tous les profils définissent tous les ions comparés', () => {
    Object.values(w.WATER_PROFILES).forEach(profile => {
        w.PROFILE_IONS.forEach(ion => assert.equal(typeof profile.ions[ion], 'number', `${profile.name} ${ion}`));
    });
});

// --- Solveur ---

// Eau douce réelle (Foix, réseau 009001053)
const SOFT_WATER = {
    'CALCIUM (CA)': 11.2, 'MAGNESIUM (MG)': 0.59, 'SODIUM (NA)': 3.01, 'SULFATES (SO4)': 3.5,
    'CHLORURES': 1.8, 'POTASSIUM (K)': 0.7, 'HCO3': 40.87
};

for (const id of ['houblonne', 'neipa', 'equilibre']) {
    test(`solveur : eau douce → profil ${id} à 15 % près (hors HCO3)`, () => {
        const target = w.WATER_PROFILES[id].ions;
        const grams = w.solveMineralAdditions(SOFT_WATER, target, 20);
        const result = w.calculateMineralAdditions(SOFT_WATER, grams, 20);
        w.PROFILE_IONS.filter(ion => ion !== 'HCO3').forEach(ion => {
            approx(result[ion], target[ion], Math.max(target[ion] * 0.15, 10), ion);
        });
    });
}

test('solveur : quantités positives, aucun ajout si la cible est déjà atteinte', () => {
    const target = w.WATER_PROFILES.equilibre.ions;
    const grams = w.solveMineralAdditions(target, target, 20);
    Object.values(grams).forEach(g => assert.equal(g, 0));
    const fromSoft = w.solveMineralAdditions(SOFT_WATER, w.WATER_PROFILES.burton.ions, 20);
    Object.values(fromSoft).forEach(g => assert.ok(g >= 0));
});

// --- Fusion des sources ---

const hubEau = { data: [
    { code_prelevement: 'P1', code_parametre: '1374', resultat_numerique: 10, date_prelevement: '2024-01-10T08:00:00Z' },
    { code_prelevement: 'P2', code_parametre: '1374', resultat_numerique: 12, date_prelevement: '2026-05-01T08:00:00Z' },
    { code_prelevement: 'P3', code_parametre: '1374', resultat_numerique: null, date_prelevement: '2026-06-01T08:00:00Z' }
] };
const sise = { data: [
    { code_prelevement: 'P2', code_parametre: '1374', resultat_numerique: 12.5, date_prelevement: '2026-05-01' },
    { code_prelevement: 'P4', code_parametre: 1374, resultat_numerique: '14', date_prelevement: '2026-08-01' }
] };

test('fusion : dédoublonnage par prélèvement, SISE prioritaire, valeurs invalides écartées', () => {
    const merged = w.mergeAnalyses([
        { data: sise, source: w.DATA_SOURCES.SISE_EAUX },
        { data: hubEau, source: w.DATA_SOURCES.HUBEAU }
    ]);
    assert.equal(merged.length, 3); // P1 (Hub'Eau), P2 (SISE), P4 (SISE) ; P3 sans valeur
    const p2 = merged.find(a => a.date.toISODate() === '2026-05-01');
    assert.equal(p2.value, 12.5);
    assert.equal(p2.source, w.DATA_SOURCES.SISE_EAUX);
    assert.ok(merged.every(a => a.code_parametre === '1374' && typeof a.value === 'number'));
});

test('fusion : source absente ou en erreur ignorée', () => {
    const merged = w.mergeAnalyses([{ data: null, source: w.DATA_SOURCES.SISE_EAUX }, { data: hubEau, source: w.DATA_SOURCES.HUBEAU }]);
    assert.equal(merged.length, 2);
});

const analysis = (code, value, isoDate, source = w.DATA_SOURCES.SISE_EAUX) =>
    ({ code_parametre: code, value, date: luxon.DateTime.fromISO(isoDate), source });

test('HCO3 : mesuré complété par le calcul TAC les jours sans mesure', () => {
    const { parameterGroups, labels } = w.buildParameterGroups([
        analysis('1347', 10, '2026-01-01'),
        analysis('1347', 20, '2026-02-01'),
        analysis('1327', 100, '2026-01-01')
    ]);
    const hco3 = parameterGroups['HCO3'];
    assert.equal(hco3.length, 2);
    assert.equal(hco3[0].value, 244); // 20 °f calculé, le plus récent en premier
    assert.equal(hco3[0].source, w.CALCULATED_SOURCE);
    assert.equal(hco3[1].value, 100); // mesuré, prioritaire sur le calcul du même jour
    assert.equal(labels['HCO3'], 'HCO3 (mesuré + calculé)');
});

test('HCO3 : uniquement calculé si jamais mesuré', () => {
    const { labels } = w.buildParameterGroups([analysis('1347', 10, '2026-01-01')]);
    assert.equal(labels['HCO3'], 'HCO3 (calculé)');
});

test('statistiques : seules les mesures des 12 mois précédant la dernière comptent', () => {
    const stats = w.computeYearStats([
        analysis('1374', 20, '2026-08-01'),
        analysis('1374', 10, '2026-01-01'),
        analysis('1374', 999, '2025-06-01')
    ]);
    assert.deepEqual(stats, { n: 2, min: 10, max: 20, avg: 15 });
});

// --- Sélection et tri ---

test('tri des départements : Corse entre 19 et 21, DOM à la fin', () => {
    const codes = ['21', '2B', '01', '971', '2A', '19', '02'];
    codes.sort((a, b) => w.departementSortKey(a) - w.departementSortKey(b));
    assert.deepEqual(codes, ['01', '02', '19', '2A', '2B', '21', '971']);
});

test('sélection : codes mal formés rejetés', () => {
    assert.deepEqual(
        w.sanitizeSelection({ dept: '09', commune: '09122', reseau: '<script>', autre: 'x' }),
        { dept: '09', commune: '09122' }
    );
});
