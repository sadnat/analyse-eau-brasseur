const { parse } = require('csv-parse');
const unzipper = require('unzipper');

// Codes SANDRE des parametres d'interet pour le brassage
const PARAM_CODES = new Set([
    '1374', // Calcium
    '1372', // Magnesium
    '1375', // Sodium
    '1338', // Sulfates
    '1337', // Chlorures
    '1367', // Potassium
    '1302', // pH
    '1347', // TAC
    '1327'  // HCO3 (Bicarbonates)
]);

// Nombre de lignes inserees par transaction
const BATCH_SIZE = 10000;

// Nettoyer une valeur CSV (guillemets residuels)
const clean = (value) => (value || '').replace(/^"|"$/g, '').trim();

// Parser un fichier CSV/TXT du ZIP en streaming et inserer par lots.
// Entre deux lots, on rend la main a la boucle d'evenements pour que l'API reste reactive.
async function importCsvEntry(entry, db, insertStmt, mapRow) {
    const parser = entry.stream().pipe(parse({
        delimiter: ',',
        // En-tetes en minuscules : les fichiers varient selon les annees (Cdreseau, CDRESEAU...)
        columns: (header) => header.map(h => h.toLowerCase()),
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
        bom: true,
        quote: '"'
    }));

    const insertBatch = db.transaction((rows) => {
        for (const row of rows) insertStmt.run(...row);
    });

    let batch = [];
    let total = 0;
    for await (const row of parser) {
        const values = mapRow(row);
        if (!values) continue;
        batch.push(values);
        if (batch.length >= BATCH_SIZE) {
            insertBatch(batch);
            total += batch.length;
            batch = [];
            await new Promise(setImmediate);
        }
    }
    if (batch.length > 0) {
        insertBatch(batch);
        total += batch.length;
    }
    return total;
}

// Importer les donnees d'un ZIP dans la base SQLite
async function importZipToDb(zipPath, db) {
    console.log(`[sync] Extraction et import des CSV de ${zipPath}...`);

    const directory = await unzipper.Open.file(zipPath);
    const files = directory.files;

    // Trier les fichiers par type (noms: DIS_COM_UDI_2025.txt, DIS_PLV_2025_XXX.txt, DIS_RESULT_2025_XXX.txt)
    const comUdiFiles = files.filter(f => /COM_UDI/i.test(f.path) && /\.(txt|csv)$/i.test(f.path));
    const plvFiles = files.filter(f => /DIS_PLV/i.test(f.path) && /\.(txt|csv)$/i.test(f.path));
    const resultFiles = files.filter(f => /DIS_RESULT/i.test(f.path) && /\.(txt|csv)$/i.test(f.path));

    console.log(`[sync] Fichiers trouves: ${comUdiFiles.length} COM_UDI, ${plvFiles.length} PLV, ${resultFiles.length} RESULT`);

    // Prepared statements
    const insertComUdi = db.prepare(
        'INSERT INTO com_udi (Inseecommune, Nomcommune, Cdreseau, Nomreseau, Debutalim) VALUES (?, ?, ?, ?, ?)'
    );
    const insertPlv = db.prepare(
        'INSERT OR IGNORE INTO plv (Cddept, Cdreseau, Referenceprel, Dateprel, Heureprel) VALUES (?, ?, ?, ?, ?)'
    );
    const insertResult = db.prepare(
        'INSERT INTO result (Cddept, Referenceprel, Cdparametre, libMAJparametre, ValTraduite, cdunitereferencesiseeaux) VALUES (?, ?, ?, ?, ?, ?)'
    );

    let totalComUdi = 0;
    let totalPlv = 0;
    let totalResult = 0;

    // Import COM_UDI
    for (const file of comUdiFiles) {
        console.log(`[sync] Import ${file.path}...`);
        totalComUdi += await importCsvEntry(file, db, insertComUdi, (row) => {
            const commune = clean(row.inseecommune);
            const reseau = clean(row.cdreseau);
            if (!commune || !reseau) return null;
            return [commune, clean(row.nomcommune), reseau, clean(row.nomreseau), clean(row.debutalim)];
        });
    }
    console.log(`[sync] COM_UDI: ${totalComUdi} enregistrements`);

    // Import PLV
    for (const file of plvFiles) {
        totalPlv += await importCsvEntry(file, db, insertPlv, (row) => {
            const ref = clean(row.referenceprel);
            const reseau = clean(row.cdreseau);
            if (!ref || !reseau) return null;
            return [clean(row.cddept), reseau, ref, clean(row.dateprel), clean(row.heureprel)];
        });
    }
    console.log(`[sync] PLV: ${totalPlv} enregistrements`);

    // Import RESULT - filtrer uniquement les parametres d'interet
    for (const file of resultFiles) {
        totalResult += await importCsvEntry(file, db, insertResult, (row) => {
            const paramCode = clean(row.cdparametre);
            if (!paramCode || !PARAM_CODES.has(paramCode)) return null;

            const ref = clean(row.referenceprel);
            if (!ref) return null;

            const numVal = parseFloat(clean(row.valtraduite));

            return [
                clean(row.cddept),
                ref,
                paramCode,
                clean(row.libmajparametre),
                isNaN(numVal) ? null : numVal,
                clean(row.cdunitereferencesiseeaux)
            ];
        });
    }
    console.log(`[sync] RESULT: ${totalResult} enregistrements (parametres brassage uniquement)`);

    return { totalComUdi, totalPlv, totalResult };
}

module.exports = { importZipToDb, PARAM_CODES };
