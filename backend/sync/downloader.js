const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Jeu de données data.gouv « Résultats du contrôle sanitaire de l'eau distribuée commune par commune »
const DATASET_API_URL = 'https://www.data.gouv.fr/api/1/datasets/5cf8d9ed8b4c4110294c841d/';
const RESOURCE_TITLE_RE = /^dis-(\d{4})-dept\.zip$/i;

// Déterminer les ZIP à importer :
// - SISE_EAUX_ZIP_URL (liste séparée par des virgules) si défini
// - sinon les SISE_EAUX_YEARS (défaut 2) années les plus récentes publiées sur data.gouv
async function resolveZipUrls() {
    if (process.env.SISE_EAUX_ZIP_URL) {
        return process.env.SISE_EAUX_ZIP_URL.split(',').map(u => u.trim()).filter(Boolean);
    }

    const years = parseInt(process.env.SISE_EAUX_YEARS, 10) || 2;
    const response = await fetch(DATASET_API_URL, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) {
        throw new Error(`API data.gouv: HTTP ${response.status}`);
    }
    const dataset = await response.json();

    const resources = (dataset.resources || [])
        .map(r => ({ url: r.url, match: RESOURCE_TITLE_RE.exec(r.title || '') }))
        .filter(r => r.match && r.url)
        .sort((a, b) => b.match[1] - a.match[1])
        .slice(0, years);

    if (resources.length === 0) {
        throw new Error('Aucune ressource dis-AAAA-dept.zip trouvee sur data.gouv');
    }
    return resources.map(r => r.url);
}

// Télécharger un ZIP vers destPath (écriture dans un .part puis renommage atomique)
async function downloadZip(url, destPath) {
    console.log(`[sync] Telechargement depuis ${url}...`);

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const response = await fetch(url, {
        headers: { 'Accept': 'application/zip' },
        redirect: 'follow'
    });

    if (!response.ok) {
        throw new Error(`Echec du telechargement: HTTP ${response.status}`);
    }

    const contentLength = parseInt(response.headers.get('content-length'), 10);
    console.log(`[sync] Taille: ${contentLength ? (contentLength / 1024 / 1024).toFixed(1) + ' Mo' : 'inconnue'}`);

    const partPath = destPath + '.part';
    try {
        await pipeline(response.body, fs.createWriteStream(partPath));

        const stats = fs.statSync(partPath);
        if (contentLength && stats.size !== contentLength) {
            throw new Error(`Telechargement incomplet: ${stats.size}/${contentLength} octets`);
        }
        fs.renameSync(partPath, destPath);
        console.log(`[sync] ZIP telecharge: ${(stats.size / 1024 / 1024).toFixed(1)} Mo`);
    } finally {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    }

    return destPath;
}

module.exports = { resolveZipUrls, downloadZip, DATA_DIR };
