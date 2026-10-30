// Test de fumée navigateur (Chromium headless via Playwright) sur l'application déployée.
// Nécessite Internet (geo.api.gouv.fr, Hub'Eau, CDN) ; non exécuté au build. Lancement :
//   docker run --rm --network analyse-eau-brasseur_backend -v "$PWD/e2e:/e2e:ro" \
//     mcr.microsoft.com/playwright:v1.48.2-jammy \
//     sh -c 'cp /e2e/smoke.js /tmp && cd /tmp && npm i -s playwright@1.48.2 && node smoke.js'
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const BASE_URL = process.env.E2E_BASE_URL || 'http://eau-app/';
// Foix (09) : quatre réseaux, données Hub'Eau depuis 2016 et SISE-Eaux récentes
const FOIX = '?dept=09&commune=09122';
const CARDS = '#results:not(.hidden) #parameterCards > article';
const PRESSED = '#networkButtons button[aria-pressed="true"]';

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
    const firstCardText = (page) => page.$eval('#parameterCards > article', d => d.innerText.replace(/\s+/g, ' '));

    try {
        const page = await newPage({ viewport: { width: 1280, height: 900 } });

        await step('accueil : explications puis recherche « Foix » au clavier', async () => {
            await page.goto(BASE_URL);
            assert.ok(await page.isVisible('#welcome'));
            await page.fill('#communeSearch', 'Foix');
            await page.waitForSelector('#communeSuggestions [role="option"]');
            assert.equal(await page.getAttribute('#communeSearch', 'aria-expanded'), 'true');
            await page.keyboard.press('ArrowDown');
            assert.match(await page.getAttribute('#communeSearch', 'aria-activedescendant'), /commune-option-0/);
            await page.keyboard.press('Enter');
            await page.waitForSelector('#networkButtons:not(.hidden) button', { timeout: 30000 });
            assert.match(await page.inputValue('#communeSearch'), /^Foix \(09000\) — Ariège$/);
            assert.equal(await page.isVisible('#welcome'), false);
            assert.ok((await page.$$('#networkButtons button')).length > 1, 'Foix a plusieurs réseaux');
            await page.click('button[data-network-code="009001053"]');
            await page.waitForSelector(CARDS, { timeout: 30000 });
            assert.match(page.url(), /commune=09122&reseau=009001053/);
        });

        await step('recherche par code postal « 09000 »', async () => {
            const cpPage = await newPage();
            await cpPage.goto(BASE_URL);
            await cpPage.fill('#communeSearch', '09000');
            await cpPage.waitForSelector('#communeSuggestions [role="option"]');
            assert.match(await cpPage.innerText('#communeSuggestions'), /Foix/);
            await cpPage.close();
        });

        await step('commune à réseau unique : sélection automatique', async () => {
            const single = await newPage();
            await single.goto(BASE_URL);
            await single.fill('#communeSearch', 'Aigues-Juntes');
            await single.waitForSelector('#communeSuggestions [role="option"]');
            await single.click('#communeSuggestions [role="option"]');
            await single.waitForSelector(CARDS, { timeout: 30000 });
            assert.equal((await single.$$('#networkButtons button')).length, 1);
            assert.equal((await single.$$(PRESSED)).length, 1);
            await single.close();
        });

        await step('ancien lien partagé : commune et réseau restaurés', async () => {
            await page.goto(BASE_URL + FOIX + '&reseau=009001053');
            await page.waitForSelector(CARDS, { timeout: 30000 });
            assert.match(await page.inputValue('#communeSearch'), /^Foix/);
            assert.equal(await page.$eval(PRESSED, b => b.dataset.networkCode), '009001053');
        });

        await step('cartes, indicateurs, alertes qualité et graphiques', async () => {
            await page.waitForSelector('#qualityAlerts:not(.hidden)');
            assert.ok((await page.$$('#parameterCards > article')).length >= 6);
            assert.match(await page.innerText('#waterSummary'), /^Eau très douce/);
            await page.click('#brewingIndicators .help-button');
            assert.equal(await page.getAttribute('#brewingIndicators .help-button', 'aria-expanded'), 'true');
            assert.match(await page.innerText('#brewingIndicators'), /degrés français/);
            assert.match(await page.innerText('#brewingIndicators'), /ALCALINITÉ RÉSIDUELLE/i);
            assert.match(await page.innerText('#qualityAlerts'), /Campden/);
            assert.match(await page.innerText('#dataSourceInfo'), /Sources : /);
        });

        await step('onglets au clavier, onglet actif dans l\'URL', async () => {
            await page.focus('#tab-eau');
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.getAttribute('#tab-calculateur', 'aria-selected'), 'true');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-calculateur');
            assert.ok(await page.isVisible('#panel-calculateur'));
            assert.equal(await page.isVisible('#panel-eau'), false);
            assert.match(page.url(), /onglet=calculateur/);
            await page.keyboard.press('ArrowRight');
            assert.ok(await page.isVisible('#panel-historique'));
            await page.waitForSelector('#chartsGrid canvas');
            await page.keyboard.press('Home');
            assert.ok(await page.isVisible('#panel-eau'));
        });

        await step('solveur : profil NEIPA → ajouts suggérés et tableau de comparaison', async () => {
            await page.click('#tab-calculateur');
            await page.selectOption('#targetProfile', 'neipa');
            await page.click('#suggestAdditions');
            assert.ok(parseFloat(await page.inputValue('#calciumChloride')) > 0);
            assert.match(await page.innerText('#profileTable'), /CHLORURES/);
        });

        await step('eau de base : le maximum 12 mois change le calcium de base', async () => {
            const calcium = () => page.$eval('#baseWaterParams', el => el.innerText.match(/CALCIUM \(CA\):\s*([\d,]+)/)[1]);
            const last = await calcium();
            await page.selectOption('#baseWaterMode', 'maximum');
            assert.notEqual(await calcium(), last);
            await page.selectOption('#baseWaterMode', 'derniere');
            assert.equal(await calcium(), last);
        });

        await step('export BeerXML : fichier avec eau de base et eau modifiée', async () => {
            const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBeerXml')]);
            assert.equal(download.suggestedFilename(), 'eau-09122-009001053.xml');
            const xml = require('fs').readFileSync(await download.path(), 'utf8');
            assert.equal((xml.match(/<WATER>/g) || []).length, 2);
            assert.match(xml, /<CALCIUM>[\d.]+<\/CALCIUM>/);
            assert.match(xml, /Modifiée — NEIPA/);
            assert.match(xml, /FOIX CENTRE VILLE/);
        });

        await step('fiche imprimable : seule visible à l\'impression, avec réseau et sels', async () => {
            await page.evaluate(() => { window.print = () => {}; }); // pas de boîte de dialogue en headless
            await page.click('#printSheet');
            assert.equal(await page.isVisible('#brewSheet'), false, 'masquée à l\'écran');
            await page.emulateMedia({ media: 'print' });
            assert.equal(await page.isVisible('#brewSheet'), true);
            assert.equal(await page.isVisible('#results'), false);
            const text = await page.innerText('#brewSheet');
            assert.match(text, /FOIX CENTRE VILLE/);
            assert.match(text, /Chlorure de calcium/);
            assert.match(text, /Campden/);
            await page.emulateMedia({ media: 'screen' });
        });

        await step('changement rapide de réseau : le dernier clic gagne', async () => {
            const racePage = await newPage();
            // Réponses du premier réseau retardées pour provoquer la course
            await racePage.route(/code_reseau=009001054/, async route => {
                await new Promise(resolve => setTimeout(resolve, 3000));
                route.continue();
            });
            await racePage.goto(BASE_URL + FOIX);
            await racePage.waitForSelector('#networkButtons:not(.hidden) button', { timeout: 30000 });
            await racePage.click('button[data-network-code="009001054"]');
            await racePage.click('button[data-network-code="009001055"]');
            await racePage.waitForTimeout(6000);

            const refPage = await newPage();
            await refPage.goto(BASE_URL + FOIX + '&reseau=009001055');
            await refPage.waitForSelector(CARDS, { timeout: 30000 });
            assert.equal(await firstCardText(racePage), await firstCardText(refPage));
        });

        await step('mobile 390 px : pas de défilement horizontal', async () => {
            const mobile = await newPage({ viewport: { width: 390, height: 844 } });
            await mobile.goto(BASE_URL + FOIX + '&reseau=009001053');
            await mobile.waitForSelector(CARDS, { timeout: 30000 });
            for (const tab of ['eau', 'calculateur', 'historique']) {
                await mobile.click(`#tab-${tab}`);
                if (tab === 'calculateur') await mobile.selectOption('#targetProfile', 'houblonne');
                assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, tab);
            }
        });

        await step("Hub'Eau muet : SISE-Eaux affiché seul après le délai maximal", async () => {
            // Console non surveillée : les requêtes bloquées y journalisent des erreurs attendues
            const hang = await browser.newPage();
            await hang.route(/hubeau\.eaufrance\.fr/, () => {}); // requêtes jamais servies
            await hang.goto(BASE_URL + FOIX + '&reseau=009001053');
            await hang.waitForSelector(CARDS, { timeout: 60000 });
            assert.match(await hang.innerText('#dataSourceInfo'), /SISE-Eaux/);
        });

        await step('erreur réseau : message et bouton « Réessayer »', async () => {
            // Console non surveillée : l'échec simulé y journalise une erreur attendue
            const failing = await browser.newPage();
            let blocked = true;
            await failing.route(/communes_udi/, route => (blocked ? route.abort() : route.continue()));
            await failing.goto(BASE_URL + FOIX);
            await failing.waitForSelector('#error:not(.hidden)', { timeout: 30000 });
            assert.ok(await failing.isVisible('#retryButton'));
            blocked = false;
            await failing.click('#retryButton');
            await failing.waitForSelector('#networkButtons:not(.hidden) button', { timeout: 30000 });
            assert.equal(await failing.isVisible('#error'), false);
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
