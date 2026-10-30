const express = require('express');
const router = express.Router();
const { getDb } = require('../db/connection');
const { isSyncing } = require('../sync/index');

// Code reseau SISE : 9 caracteres (ex. 009000837, 02A000123 en Corse)
const CODE_RESEAU_RE = /^[0-9AB]{9}$/i;
const MAX_PARAMETRES = 20;
// Donnees rafraichies chaque semaine : cache navigateur/proxy d'une heure
const CACHE_CONTROL = 'public, max-age=3600';

// GET /api/sise/communes_udi?code_commune=XXXXX
router.get('/communes_udi', (req, res) => {
    const { code_commune } = req.query;
    if (!code_commune || !/^\d{5}$/.test(code_commune)) {
        return res.status(400).json({ error: 'code_commune requis (5 chiffres)' });
    }

    try {
        const db = getDb();
        const rows = db.prepare(`
            SELECT DISTINCT Cdreseau AS code_reseau, Nomreseau AS nom_reseau
            FROM com_udi
            WHERE Inseecommune = ?
            ORDER BY Nomreseau
        `).all(code_commune);

        res.set('Cache-Control', CACHE_CONTROL);
        res.json({ count: rows.length, data: rows });
    } catch (error) {
        console.error('[api] Erreur communes_udi:', error.message);
        res.status(500).json({ error: 'Erreur interne' });
    }
});

// GET /api/sise/resultats?code_reseau=XXXXX&code_parametre=1374,1372,...
router.get('/resultats', (req, res) => {
    const { code_reseau, code_parametre } = req.query;
    if (!code_reseau || !CODE_RESEAU_RE.test(code_reseau)) {
        return res.status(400).json({ error: 'code_reseau requis (9 caracteres)' });
    }

    // Seuls les codes SANDRE numeriques sont retenus (le front envoie aussi le pseudo-code HCO3)
    const codes = (code_parametre || '').split(',').map(c => c.trim()).filter(c => /^\d{1,5}$/.test(c));
    if (codes.length > MAX_PARAMETRES) {
        return res.status(400).json({ error: `${MAX_PARAMETRES} parametres maximum` });
    }

    try {
        const db = getDb();

        // Construire le filtre parametres
        const paramFilter = codes.length > 0
            ? `AND r.Cdparametre IN (${codes.map(() => '?').join(',')})`
            : '';
        const params = [code_reseau.toUpperCase(), ...codes];

        const rows = db.prepare(`
            SELECT
                r.Referenceprel AS code_prelevement,
                r.Cdparametre AS code_parametre,
                r.libMAJparametre AS libelle_parametre,
                r.ValTraduite AS resultat_numerique,
                r.cdunitereferencesiseeaux AS libelle_unite,
                p.Dateprel AS date_prelevement
            FROM result r
            JOIN plv p ON r.Referenceprel = p.Referenceprel
            WHERE p.Cdreseau = ?
            ${paramFilter}
            AND r.ValTraduite IS NOT NULL
            ORDER BY p.Dateprel DESC
            LIMIT 5000
        `).all(...params);

        res.set('Cache-Control', CACHE_CONTROL);
        res.json({ count: rows.length, data: rows });
    } catch (error) {
        console.error('[api] Erreur resultats:', error.message);
        res.status(500).json({ error: 'Erreur interne' });
    }
});

// GET /api/sise/health
router.get('/health', (req, res) => {
    try {
        const db = getDb();
        const info = db.prepare('SELECT * FROM sync_info WHERE id = 1').get();
        const recordCount = info ? info.record_count : 0;
        // Pendant une sync, l'ancienne base reste servie : le statut reste 'ok'
        res.json({
            status: recordCount > 0 ? 'ok' : 'no_data',
            syncing: isSyncing(),
            last_sync: info ? info.last_sync : null,
            record_count: recordCount
        });
    } catch (error) {
        res.json({
            status: 'no_data',
            syncing: isSyncing(),
            last_sync: null,
            record_count: 0
        });
    }
});

module.exports = router;
