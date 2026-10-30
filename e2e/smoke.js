// Test de fumée navigateur (Chromium headless via Playwright) sur l'application déployée.
// Nécessite Internet (geo.api.gouv.fr, Hub'Eau, CDN) ; non exécuté au build. Lancement :
//   docker run --rm --network analyse-eau-brasseur_backend -v "$PWD/e2e:/e2e:ro" \
//     mcr.microsoft.com/playwright:v1.48.2-jammy \
//     sh -c 'cp /e2e/smoke.js /tmp && cd /tmp && npm i -s playwright@1.48.2 && node smoke.js'
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const BASE_URL = process.env.E2E_BASE_URL || 'http://eau-app/';
// Foix (09) : quatre réseaux, données Hub'Eau depuis 2016 et SISE-Eaux récentes
const SELECTION = '?dept=09&commune=09122';
const CARDS = '#currentParameters:not(.hidden) .grid > div';

const steps = [];
const step = async (name, fn) => {
    await fn();
    steps.push(name);
    console.log(`✔ ${name}`);
};

(async () => {
    const browser = await chromium.launch();
    const problems = [];
    const newPage = async (options) => {
        const page = await browser.newPage(options);
        page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`); });
        page.on('pageerror', e => problems.push(`[pageerror] ${e.message}`));
        return page;
    };
    const firstCardText = (page) => page.$eval('#currentParameters .grid > div', d => d.innerText.replace(/\s+/g, ' '));

    try {
        const page = await newPage({ viewport: { width: 1280, height: 900 } });

        await step('lien partagé : département, commune et réseau restaurés', async () => {
            await page.goto(BASE_URL + SELECTION + '&reseau=009001053');
            await page.waitForSelector(CARDS, { timeout: 30000 });
            assert.equal(await page.$eval('#departementSelect', s => s.value), '09');
            assert.equal(await page.$eval('#communeSelect', s => s.value), '09122');
            assert.equal(await page.$eval('#networkButtons button.bg-sky-600', b => b.dataset.networkCode), '009001053');
        });

        await step('cartes, indicateurs et graphiques affichés', async () => {
            await page.waitForSelector('#chartsGrid canvas');
            assert.ok((await page.$$('#currentParameters > .grid > div')).length >= 6);
            assert.match(await page.innerText('#brewingIndicators'), /ALCALINITÉ RÉSIDUELLE/i);
            assert.match(await page.innerText('#dataSourceInfo'), /Sources : /);
            assert.ok((await page.$$('#chartsGrid canvas')).length >= 6);
        });

        await step('solveur : profil NEIPA → ajouts suggérés et tableau de comparaison', async () => {
            await page.click('#openCalculator');
            await page.selectOption('#targetProfile', 'neipa');
            await page.click('#suggestAdditions');
            assert.ok(parseFloat(await page.inputValue('#calciumChloride')) > 0);
            assert.match(await page.innerText('#profileTable'), /CHLORURES/);
        });

        await step('changement rapide de réseau : le dernier clic gagne', async () => {
            const racePage = await newPage();
            // Réponses du premier réseau retardées pour provoquer la course
            await racePage.route(/code_reseau=009001054/, async route => {
                await new Promise(resolve => setTimeout(resolve, 3000));
                route.continue();
            });
            await racePage.goto(BASE_URL + SELECTION);
            await racePage.waitForSelector('#networkButtons:not(.hidden) button', { timeout: 30000 });
            await racePage.click('button[data-network-code="009001054"]');
            await racePage.click('button[data-network-code="009001055"]');
            await racePage.waitForTimeout(6000);

            const refPage = await newPage();
            await refPage.goto(BASE_URL + SELECTION + '&reseau=009001055');
            await refPage.waitForSelector(CARDS, { timeout: 30000 });
            assert.equal(await firstCardText(racePage), await firstCardText(refPage));
        });

        await step('mobile 390 px : pas de défilement horizontal', async () => {
            const mobile = await newPage({ viewport: { width: 390, height: 844 } });
            await mobile.goto(BASE_URL + SELECTION + '&reseau=009001053');
            await mobile.waitForSelector(CARDS, { timeout: 30000 });
            await mobile.click('#openCalculator');
            await mobile.selectOption('#targetProfile', 'houblonne');
            assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
        });

        await step("Hub'Eau muet : SISE-Eaux affiché seul après le délai maximal", async () => {
            // Console non surveillée : les requêtes bloquées y journalisent des erreurs attendues
            const hang = await browser.newPage();
            await hang.route(/hubeau\.eaufrance\.fr/, () => {}); // requêtes jamais servies
            await hang.goto(BASE_URL + SELECTION + '&reseau=009001053');
            await hang.waitForSelector(CARDS, { timeout: 60000 });
            assert.match(await hang.innerText('#dataSourceInfo'), /SISE-Eaux/);
        });

        await step('aucune erreur console ni violation CSP', async () => {
            assert.deepEqual(problems, []);
        });
    } catch (error) {
        console.error(`✖ échec après ${steps.length} étape(s) : ${error.message}`);
        if (problems.length) console.error('Console :\n  ' + problems.join('\n  '));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
