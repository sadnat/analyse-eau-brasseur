const express = require('express');
const cron = require('node-cron');
const { syncData, needsSync } = require('./sync/index');
const siseRoutes = require('./routes/sise');

const app = express();
const PORT = process.env.PORT || 3000;

// Routes API
app.use('/api/sise', siseRoutes);

// Demarrage
app.listen(PORT, async () => {
    console.log(`[server] Backend SISE-Eaux demarre sur le port ${PORT}`);

    // Sync au demarrage si pas de donnees
    if (needsSync()) {
        console.log('[server] Aucune donnee locale, lancement de la synchronisation...');
        syncData().catch(err => console.error('[server] Erreur sync initiale:', err.message));
    } else {
        console.log('[server] Donnees SISE-Eaux deja presentes');
    }

    // Sync hebdomadaire (dimanche 3h du matin)
    cron.schedule('0 3 * * 0', () => {
        console.log('[cron] Synchronisation hebdomadaire...');
        syncData().catch(err => console.error('[cron] Erreur sync:', err.message));
    });
});
