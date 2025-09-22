// src/services/scraper.js (COMPLETE AND FINAL VERSION)
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { sleep } = require('../utils/utils');

puppeteer.use(StealthPlugin());

let browserInstance = null;

const SERVER_PRIORITY = { 'Pucuk': 1, 'Nakama': 2, 'Premium': 3, 'Vidhide': 4, 'Mega': 5, 'Blogspot': 6, 'DefaultServer': 99 };
const OUTPUT_SERVER_PRIORITY_ORDER = ['Pucuk', 'Nakama', 'Premium', 'Vidhide', 'Mega', 'Blogspot'];
const TARGET_RESOLUTIONS_PER_SERVER = ['1080p', '720p', '480p'];
const TARGET_NUM_PRIMARY_SERVERS = 2;
const MIN_LINKS_FOR_SELECTION_POOL = TARGET_NUM_PRIMARY_SERVERS * TARGET_RESOLUTIONS_PER_SERVER.length + TARGET_RESOLUTIONS_PER_SERVER.length;
const MAX_SERVER_CLICKS_AT_ONCE = 5;

async function initializeBrowser() {
    if (!browserInstance) {
        console.log('[Scraper] Meluncurkan browser...');
        browserInstance = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        console.log('[Scraper] Browser berhasil diluncurkan.');
    }
    return browserInstance;
}

async function closeBrowser() {
    if (browserInstance) {
        console.log('[Scraper] Menutup browser...');
        await browserInstance.close();
        browserInstance = null;
        console.log('[Scraper] Browser ditutup.');
    }
}

async function scrapeEpisode(url, episodeNumber, onProgress = () => { }) {
    let page;
    const availableLinksMap = new Map();
    const clickedOptionIds = new Set();
    const clickedServerNamesInPhase1 = new Set();

    const reportProgress = (message) => {
        console.log(`[Scraper] ${message}`);
        onProgress(message);
    };

    try {
        const browser = await initializeBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        reportProgress(`Navigating to ${url.substring(0, 50)}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const serverSelector = 'div.east_player_option';
        try {
            reportProgress(`Waiting for server selector...`);
            await page.waitForSelector(serverSelector, { timeout: 20000 });
        } catch (e) {
            reportProgress(`Episode ${episodeNumber} (${url}) invalid or server buttons not found.`);
            if (page) await page.close();
            return { success: false, links: [] };
        }

        const serverOptionHandles = await page.$$(serverSelector);
        if (serverOptionHandles.length === 0) {
            reportProgress(`No server options found on page ${url}.`);
            if (page) await page.close();
            return { success: false, links: [] };
        }

        const allOptionDetails = [];
        for (const handle of serverOptionHandles) {
            const { id, textContent } = await page.evaluate(el => ({ id: el.id, textContent: el.textContent.trim() }), handle);
            const serverMatch = textContent.match(/^(.+?)(?:\s*(\d{3,4}p))?$/i);
            let baseServerName = serverMatch && serverMatch[1] ? serverMatch[1].trim() : 'DefaultServer';
            if (!SERVER_PRIORITY.hasOwnProperty(baseServerName)) baseServerName = 'DefaultServer';
            const quality = serverMatch && serverMatch[2] ? serverMatch[2].trim() : 'Unknown';
            allOptionDetails.push({ id, textContent, baseServerName, quality, priority: SERVER_PRIORITY[baseServerName] });
        }
        allOptionDetails.sort((a, b) => a.priority - b.priority);

        reportProgress(`Starting link extraction from ${allOptionDetails.length} options...`);

        let currentLinksInPool = 0;
        for (const option of allOptionDetails) {
            if (currentLinksInPool >= MIN_LINKS_FOR_SELECTION_POOL && clickedServerNamesInPhase1.size >= MAX_SERVER_CLICKS_AT_ONCE) {
                reportProgress(`Link pool sufficient (${currentLinksInPool} links). Stopping clicks.`);
                break;
            }
            if (clickedOptionIds.has(option.id)) continue;

            try {
                const currentOptionHandle = await page.$(`#${option.id}`);
                if (!currentOptionHandle) continue;

                reportProgress(`Clicking option: "${option.textContent}"`);
                await currentOptionHandle.click();
                clickedOptionIds.add(option.id);
                clickedServerNamesInPhase1.add(option.baseServerName);
                await sleep(5000);

                const iframeSrcs = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(iframe => iframe.src).filter(Boolean));
                const validIframeSrc = iframeSrcs.find(src => src && !src.includes('facebook.com') && !src.includes('sso.ruangotaku.com') && !src.includes('ads.google.com'));

                if (validIframeSrc) {
                    if (!availableLinksMap.has(option.baseServerName)) availableLinksMap.set(option.baseServerName, new Map());
                    if (!availableLinksMap.get(option.baseServerName).has(option.quality)) {
                        availableLinksMap.get(option.baseServerName).set(option.quality, { server: option.baseServerName, quality: option.quality, url: validIframeSrc, priority: option.priority });
                        currentLinksInPool++;
                        reportProgress(`Valid link found: ${option.baseServerName} - ${option.quality}`);
                    }
                } else {
                    reportProgress(`No valid link found for "${option.textContent}".`);
                }
            } catch (error) {
                reportProgress(`Error processing "${option.textContent}": ${error.message}`);
            }
        }

        reportProgress(`Extraction finished. Pool: ${currentLinksInPool} links from ${clickedServerNamesInPhase1.size} servers.`);

        // ============================================================================
        // BAGIAN YANG HILANG SEBELUMNYA, SEKARANG LENGKAP
        // ============================================================================
        const finalStreamLinksOutput = [];
        const selectedPrimaryServers = [];
        const occupiedQualities = new Map();

        for (const serverName of OUTPUT_SERVER_PRIORITY_ORDER) {
            if (availableLinksMap.has(serverName) && selectedPrimaryServers.length < TARGET_NUM_PRIMARY_SERVERS) {
                selectedPrimaryServers.push(serverName);
                occupiedQualities.set(serverName, new Set());
            }
            if (selectedPrimaryServers.length === TARGET_NUM_PRIMARY_SERVERS) break;
        }
        reportProgress(`Selected primary servers: ${selectedPrimaryServers.join(', ') || 'None'}`);

        reportProgress(`Building final output...`);
        if (selectedPrimaryServers.length > 0) {
            const missingSlots = [];
            for (const primaryServer of selectedPrimaryServers) {
                for (const targetQuality of TARGET_RESOLUTIONS_PER_SERVER) {
                    const link = availableLinksMap.get(primaryServer)?.get(targetQuality);
                    if (link) {
                        finalStreamLinksOutput.push(link);
                        occupiedQualities.get(primaryServer).add(targetQuality);
                    } else {
                        missingSlots.push({ server: primaryServer, quality: targetQuality });
                    }
                }
            }

            for (const missingSlot of missingSlots) {
                let patchLinkFound = null;
                for (const patchServerName of OUTPUT_SERVER_PRIORITY_ORDER) {
                    if (patchServerName === missingSlot.server) continue;
                    if (availableLinksMap.get(patchServerName)?.has(missingSlot.quality) && !occupiedQualities.get(patchServerName)?.has(missingSlot.quality)) {
                        patchLinkFound = availableLinksMap.get(patchServerName).get(missingSlot.quality);
                        break;
                    }
                }
                if (patchLinkFound) {
                    finalStreamLinksOutput.push(patchLinkFound);
                    if (!occupiedQualities.has(patchLinkFound.server)) occupiedQualities.set(patchLinkFound.server, new Set());
                    occupiedQualities.get(patchLinkFound.server).add(patchLinkFound.quality);
                }
            }
        } else if (availableLinksMap.size > 0) {
            reportProgress(`No primary servers found. Using 'best available' mode.`);
            const allLinks = Array.from(availableLinksMap.values()).flatMap(qualityMap => Array.from(qualityMap.values()));
            allLinks.sort((a, b) => a.priority - b.priority);
            finalStreamLinksOutput.push(...allLinks);
        }

        finalStreamLinksOutput.sort((a, b) => {
            const priorityA = SERVER_PRIORITY[a.server] || 99;
            const priorityB = SERVER_PRIORITY[b.server] || 99;
            if (priorityA !== priorityB) return priorityA - priorityB;
            const qualityOrder = { '1080p': 1, '720p': 2, '480p': 3 };
            return (qualityOrder[a.quality] || 99) - (qualityOrder[b.quality] || 99);
        });
        // ============================================================================
        // AKHIR DARI BAGIAN YANG HILANG
        // ============================================================================

        if (page) await page.close();
        return { success: true, links: finalStreamLinksOutput };

    } catch (error) {
        reportProgress(`General error during scraping: ${error.message}`);
        if (page) await page.close();
        return { success: false, links: [] };
    }
}

module.exports = { initializeBrowser, closeBrowser, scrapeEpisode };