// Tests du backend : import d'un ZIP SISE-Eaux réduit puis API — exécutés avec `npm test` (node:test)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Dossier de données temporaire, à définir avant de charger les modules
process.env.SISE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sise-test-'));

const express = require('express');
const { createSchemaOnPath } = require('../db/schema');
const { closeDb, DB_PATH } = require('../db/connection');
const { importZipToDb } = require('../sync/parser');
const siseRoutes = require('../routes/sise');

const FIXTURE_ZIP = path.join(__dirname, 'fixtures', 'dis-test.zip');

let stats;
let server;
let baseUrl;

// Construire une base à partir du ZIP de test
async function buildDb(dbPath) {
    const db = createSchemaOnPath(dbPath);
    const result = await importZipToDb(FIXTURE_ZIP, db);
    db.prepare('INSERT INTO sync_info (id, last_sync, source_url, record_count) VALUES (1, ?, ?, ?)')
        .run('2026-10-30T00:00:00.000Z', 'test', result.totalResult);
    db.close();
    return result;
}

const get = async (url) => {
    const response = await fetch(baseUrl + url);
    return { status: response.status, headers: response.headers, body: await response.json() };
};

before(async () => {
    stats = await buildDb(DB_PATH);
    const app = express();
    app.use('/api/sise', siseRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.close();
    closeDb();
    fs.rmSync(process.env.SISE_DATA_DIR, { recursive: true, force: true });
});

test("import : seuls les paramètres brassage sont conservés", () => {
    assert.equal(stats.totalComUdi, 3);
    assert.equal(stats.totalResult, 4); // nitrates (1340) écartés
});

test('communes_udi : réseaux de la commune, guillemets nettoyés, cache 1 h', async () => {
    const { status, headers, body } = await get('/api/sise/communes_udi?code_commune=09122');
    assert.equal(status, 200);
    assert.equal(headers.get('cache-control'), 'public, max-age=3600');
    assert.deepEqual(body.data.map(r => r.code_reseau).sort(), ['009001053', '009001054']);

    const quoted = await get('/api/sise/communes_udi?code_commune=09001');
    assert.equal(quoted.body.data[0].code_reseau, '009000001');
});

test('communes_udi : code commune invalide refusé', async () => {
    assert.equal((await get('/api/sise/communes_udi?code_commune=abc')).status, 400);
    assert.equal((await get('/api/sise/communes_udi')).status, 400);
});

test('resultats : format Hub\'Eau avec code_prelevement, valeurs non numériques exclues', async () => {
    const { status, body } = await get('/api/sise/resultats?code_reseau=009001053&code_parametre=1374,1347,1327,HCO3');
    assert.equal(status, 200);
    assert.equal(body.count, 3); // le calcium "<0.5" (ValTraduite vide) est exclu
    const calcium = body.data.find(r => r.code_parametre === '1374');
    assert.deepEqual(calcium, {
        code_prelevement: '00900000001',
        code_parametre: '1374',
        libelle_parametre: 'CALCIUM',
        resultat_numerique: 11.2,
        libelle_unite: 'mg/L',
        date_prelevement: '2026-08-27'
    });
    assert.equal(body.data[0].date_prelevement, '2026-08-27', 'tri par date décroissante');
});

test('resultats : filtre par paramètre', async () => {
    const { body } = await get('/api/sise/resultats?code_reseau=009001053&code_parametre=1327');
    assert.deepEqual(body.data.map(r => r.resultat_numerique), [40]);
});

test('resultats : paramètres invalides refusés', async () => {
    assert.equal((await get('/api/sise/resultats?code_reseau=x%27%20OR%201=1')).status, 400);
    const tooMany = Array.from({ length: 21 }, (_, i) => 1000 + i).join(',');
    assert.equal((await get(`/api/sise/resultats?code_reseau=009001053&code_parametre=${tooMany}`)).status, 400);
});

test('health : statut ok et nombre de résultats', async () => {
    const { body } = await get('/api/sise/health');
    assert.equal(body.status, 'ok');
    assert.equal(body.record_count, 4);
    assert.equal(body.syncing, false);
});

test('base remplacée par un autre processus : connexion rouverte automatiquement', async () => {
    const tempPath = DB_PATH + '.new';
    const db = createSchemaOnPath(tempPath);
    db.prepare('INSERT INTO sync_info (id, last_sync, source_url, record_count) VALUES (1, ?, ?, ?)')
        .run('2026-11-01T00:00:00.000Z', 'test', 42);
    db.close();
    fs.renameSync(tempPath, DB_PATH);

    const { body } = await get('/api/sise/health');
    assert.equal(body.record_count, 42);
    assert.equal(body.last_sync, '2026-11-01T00:00:00.000Z');
});
