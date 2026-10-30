const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Dossier de données configurable (tests) via SISE_DATA_DIR
const DB_DIR = process.env.SISE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'sise.db');

let db = null;
let dbInode = null;

// Connexion en lecture seule pour l'API.
// Si le fichier a ete remplace (sync lancee depuis un autre processus), la connexion est rouverte.
function getDb() {
    const inode = fs.statSync(DB_PATH).ino; // leve une erreur si la base n'existe pas encore
    if (db && inode === dbInode) return db;

    closeDb();
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    dbInode = inode;
    return db;
}

// Fermer la connexion (avant un swap de fichier DB)
function closeDb() {
    if (db) {
        db.close();
        db = null;
        dbInode = null;
    }
}

module.exports = { getDb, closeDb, DB_PATH, DB_DIR };
