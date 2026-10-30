const Database = require('better-sqlite3');

function createSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS com_udi (
            Inseecommune TEXT NOT NULL,
            Nomcommune TEXT,
            Cdreseau TEXT NOT NULL,
            Nomreseau TEXT,
            Debutalim TEXT
        );

        CREATE TABLE IF NOT EXISTS plv (
            Cddept TEXT,
            Cdreseau TEXT NOT NULL,
            Referenceprel TEXT PRIMARY KEY,
            Dateprel TEXT,
            Heureprel TEXT
        );

        CREATE TABLE IF NOT EXISTS result (
            Cddept TEXT,
            Referenceprel TEXT NOT NULL,
            Cdparametre TEXT NOT NULL,
            libMAJparametre TEXT,
            ValTraduite REAL,
            cdunitereferencesiseeaux TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_com_udi_commune ON com_udi(Inseecommune);
        CREATE INDEX IF NOT EXISTS idx_com_udi_reseau ON com_udi(Cdreseau);
        CREATE INDEX IF NOT EXISTS idx_plv_reseau ON plv(Cdreseau);
        CREATE INDEX IF NOT EXISTS idx_result_prel ON result(Referenceprel);
        CREATE INDEX IF NOT EXISTS idx_result_param ON result(Cdparametre);
        CREATE INDEX IF NOT EXISTS idx_result_prel_param ON result(Referenceprel, Cdparametre);

        CREATE TABLE IF NOT EXISTS sync_info (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_sync TEXT,
            source_url TEXT,
            record_count INTEGER
        );
    `);
}

// Creer le schema sur une DB temporaire (pour import atomique)
function createSchemaOnPath(dbPath) {
    const db = new Database(dbPath);
    // Base temporaire : pas de journal (en cas d'echec, le fichier est supprime).
    // Evite aussi le mode WAL, incompatible avec une ouverture en lecture seule par l'API.
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    createSchema(db);
    return db;
}

module.exports = { createSchema, createSchemaOnPath };
