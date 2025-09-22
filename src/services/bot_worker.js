
const { setBaseUrl, requestJob, submitResult } = require('../config/apiClient');
const { initializeBrowser, closeBrowser, scrapeEpisode } = require('./scraper');
const { sleep } = require('../utils/utils');

let botIdGlobal = null;
let processedCount = 0;
let isInitialized = false;

function extractBaseSlug(url) {
    let cleanUrl = url.replace(/-episode-\d+.*/, '');
    let match = cleanUrl.match(/\/anime\/([^\/]+)/);
    if (match && match[1]) return match[1];
    match = cleanUrl.match(/https?:\/\/[^\/]+\/([^\/]+)/);
    if (match && match[1]) return match[1].replace(/\/$/, '');
    return null;
}

function sendStatus(statusUpdate) {
    if (!botIdGlobal) return;
    process.send({
        type: 'STATUS_UPDATE',
        payload: { id: botIdGlobal, processedCount, ...statusUpdate }
    });
}

function queueSubmit(mal_id, episode_number, sources) {
    process.send({
        type: 'QUEUE_SUBMIT',
        payload: { mal_id, episode_number, sources }
    });
}

async function manualModeWorker(payload) {
    const { link, malId } = payload;
    await initializeBrowser();
    sendStatus({ animeTitle: `Manual Job for MAL ID ${malId}`, progressLine: 'Browser initialized.' });

    const animeSlug = extractBaseSlug(link);
    const domainMatch = link.match(/^(https?:\/\/[^\/]+)/);

    if (!animeSlug || !domainMatch) {
        sendStatus({ progressLine: `Error: Could not extract slug/domain.` });
        await closeBrowser(); process.exit(1);
    }

    const domain = domainMatch[1];
    sendStatus({ progressLine: `Extracted Slug: ${animeSlug}` });

    let mal_id = parseInt(malId, 10), startEpisode = 1, endEpisode = 0;
    if (link.toLowerCase().includes('-episode-')) {
        const match = link.match(/episode-(\d+)/i);
        if (match) { startEpisode = parseInt(match[1], 10); endEpisode = startEpisode; }
    }

    let currentEpisodeToScrape = startEpisode;
    let foundLastEpisode = false;
    const scraperProgressCallback = (message) => sendStatus({ progressLine: message });

    while (!foundLastEpisode && (endEpisode === 0 || currentEpisodeToScrape <= endEpisode)) {
        sendStatus({ episode: currentEpisodeToScrape, progressLine: `Trying patterns for Ep ${currentEpisodeToScrape}...` });
        const urlA = `${domain}/${animeSlug}-episode-${currentEpisodeToScrape}`;
        const urlB = `${domain}/anime/${animeSlug}-episode-${currentEpisodeToScrape}`;
        let scrapeResult = { success: false };

        scrapeResult = await scrapeEpisode(urlA, currentEpisodeToScrape, scraperProgressCallback);
        if (!scrapeResult.success) {
            scrapeResult = await scrapeEpisode(urlB, currentEpisodeToScrape, scraperProgressCallback);
        }

        if (!scrapeResult.success) {
            sendStatus({ progressLine: `Ep ${currentEpisodeToScrape} not found. Stopping job.` });
            foundLastEpisode = true;
        } else {
            sendStatus({ progressLine: `Ep ${currentEpisodeToScrape} Scraped! (${scrapeResult.links.length} links). submit...` });
            const submissionSuccess = await submitResult(mal_id, currentEpisodeToScrape, scrapeResult.links);

            if (submissionSuccess) {
                sendStatus({ progressLine: `Submission for Ep ${currentEpisodeToScrape} successful.` });
            } else {
                sendStatus({ progressLine: `Submission for Ep ${currentEpisodeToScrape} FAILED.` });
            }
            processedCount++;
            currentEpisodeToScrape++;
            await sleep(2000);
        }
    }
    sendStatus({ progressLine: 'Manual job finished.' });
    await closeBrowser(); process.exit(0);
}

async function mainLoopWorker() {
    await initializeBrowser();
    const scraperProgressCallback = (message) => sendStatus({ progressLine: message });

    while (true) {
        try {
            sendStatus({ animeTitle: 'Waiting for job...', progressLine: 'Requesting new job package...' });
            const animeList = await requestJob();

            if (!animeList || animeList.length === 0) {
                sendStatus({ progressLine: `No jobs available. Waiting for 10 mins.` });
                await sleep(10 * 60 * 1000); continue;
            }

            for (const anime of animeList) {
                processedCount = 0;
                sendStatus({ animeTitle: anime.title, progressLine: `Starting job for ${anime.title}` });
                const baseUrl = anime.base_links[0]?.url;
                if (!baseUrl) { sendStatus({ progressLine: `Skipping ${anime.title}: No base link.` }); continue; }

                const animeSlug = extractBaseSlug(baseUrl);
                const domainMatch = baseUrl.match(/^(https?:\/\/[^\/]+)/);
                if (!animeSlug || !domainMatch) { sendStatus({ progressLine: `Skipping ${anime.title}: Could not extract slug.` }); continue; }
                const domain = domainMatch[1];

                let currentEpisodeNumber = 1;
                let foundLastEpisode = false;

                while (!foundLastEpisode) {
                    sendStatus({ episode: currentEpisodeNumber, progressLine: `Trying patterns for Ep ${currentEpisodeNumber}...` });
                    const urlA = `${domain}/${animeSlug}-episode-${currentEpisodeNumber}`;
                    const urlB = `${domain}/anime/${animeSlug}-episode-${currentEpisodeNumber}`;
                    let scrapeResult = { success: false };

                    scrapeResult = await scrapeEpisode(urlA, currentEpisodeNumber, scraperProgressCallback);
                    if (!scrapeResult.success) {
                        scrapeResult = await scrapeEpisode(urlB, currentEpisodeNumber, scraperProgressCallback);
                    }

                    if (!scrapeResult.success) {
                        sendStatus({ progressLine: `Ep ${currentEpisodeNumber} not found. Finishing job for this anime.` });
                        foundLastEpisode = true;
                    } else {
                        sendStatus({ progressLine: `Ep ${currentEpisodeNumber} Scraped! (${scrapeResult.links.length} links). Queueing...` });
                        queueSubmit(anime.mal_id, currentEpisodeNumber, scrapeResult.links);
                        processedCount++;
                        currentEpisodeNumber++;
                        await sleep(2000);
                    }
                }
            }
        } catch (error) {
            console.error(`[Worker ${botIdGlobal}] Error in main loop:`, error.message);
            sendStatus({ progressLine: `An error occurred. Retrying in 30 seconds.` });
            await sleep(30000);
        }
    }
}

process.on('message', async (msg) => {
    if (msg.type === 'INIT') {
        botIdGlobal = msg.payload.botId;
        setBaseUrl(msg.payload.apiUrl);
        isInitialized = true;
        console.log(`[Worker ${botIdGlobal}] Initialized with API URL: ${msg.payload.apiUrl}`);
    } else if (isInitialized) {
        if (msg.type === 'START_MANUAL') {
            await manualModeWorker(msg.payload);
        } else if (msg.type === 'START_AUTO') {
            await mainLoopWorker();
        }
    }
});

process.on('SIGTERM', async () => {
    console.log(`[Worker ${botIdGlobal}] SIGTERM received. Closing browser...`);
    await closeBrowser();
    process.exit(0);
});