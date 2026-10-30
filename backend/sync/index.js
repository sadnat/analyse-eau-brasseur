const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveZipUrls, downloadZip, DATA_DIR } = require('./downloader');
const { importZipToDb } = require('./parser');
const { createSchemaOnPath } = require('../db/schema');
const { closeDb, DB_PATH } = require('../db/connection');

// Fichier verrou partage entre le serveur et `node sync/index.js` (meme conteneur)
const LOCK_PATH = path.join(DATA_DIR, 'sync.lock');
// Au-dela de cet age, les donnees sont considerees perimees au demarrage
const MAX_DATA_AGE_MS = 7 * 24 * 3600 * 1000;

let syncing = false;

// Prendre le verrou ; un verrou laisse par un processus mort est ignore
function acquireLock() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
        fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
        return true;
    } catch {
        const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
        try {
            process.kill(pid, 0);
            return false; // processus toujours actif
        } catch {
            fs.unlinkSync(LOCK_PATH);
            return acquireLock();
        }
    }
}

function releaseLock() {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
}

async function syncData() {
    if (syncing || !acquireLock()) {
        console.log('[sync] Synchronisation deja en cours, ignoree.');
        return;
    }

    syncing = true;
    const tempDbPath = path.join(DATA_DIR, 'sise_new.db');
    const zipPath = path.join(DATA_DIR, 'sise-eaux.zip');

    try {
        console.log('[sync] Demarrage de la synchronisation SISE-Eaux...');
        const startTime = Date.now();

        // 1. Determiner les ZIP a importer (annees les plus recentes)
        const urls = await resolveZipUrls();

        // 2. Creer une nouvelle DB temporaire
        if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
        const tempDb = createSchemaOnPath(tempDbPath);

        // 3. Telecharger et importer chaque ZIP, l'un apres l'autre (limite l'espace disque)
        let totalResult = 0;
        try {
            for (const url of urls) {
                await downloadZip(url, zipPath);
                const stats = await importZipToDb(zipPath, tempDb);
                totalResult += stats.totalResult;
                fs.unlinkSync(zipPath);
            }

            if (totalResult === 0) {
                throw new Error('Aucun resultat importe, base actuelle conservee');
            }

            tempDb.prepare(
                'INSERT OR REPLACE INTO sync_info (id, last_sync, source_url, record_count) VALUES (1, ?, ?, ?)'
            ).run(new Date().toISOString(), urls.join(','), totalResult);
        } finally {
            tempDb.close();
        }

        // 4. Swap : fermer la connexion de l'API avant de remplacer le fichier
        closeDb();
        fs.renameSync(tempDbPath, DB_PATH);
        // Fichiers WAL/SHM residuels d'une ancienne base en mode WAL
        [DB_PATH + '-wal', DB_PATH + '-shm'].forEach(f => {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[sync] Synchronisation terminee en ${duration}s — ${totalResult} resultats importes`);
    } catch (error) {
        console.error('[sync] Erreur:', error.message);
        // Nettoyer en cas d'erreur
        if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } finally {
        syncing = false;
        releaseLock();
    }
}

function isSyncing() {
    return syncing || fs.existsSync(LOCK_PATH);
}

// Sync necessaire si pas de base, base vide ou donnees de plus de 7 jours
function needsSync() {
    if (!fs.existsSync(DB_PATH)) return true;
    try {
        const db = new Database(DB_PATH, { readonly: true });
        const row = db.prepare('SELECT last_sync, record_count FROM sync_info WHERE id = 1').get();
        db.close();
        if (!row || !row.record_count) return true;
        return Date.now() - new Date(row.last_sync).getTime() > MAX_DATA_AGE_MS;
    } catch {
        return true;
    }
}

// Execution directe : `node sync/index.js`
if (require.main === module) {
    syncData();
}

module.exports = { syncData, isSyncing, needsSync };
