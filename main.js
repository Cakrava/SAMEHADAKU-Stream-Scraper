// main.js
const readline = require('readline');

const { setBaseUrl, requestJob, submitResult } = require('./apiClient');
const { initializeBrowser, closeBrowser, scrapeEpisode } = require('./scraper');
const { sleep } = require('./utils');

const JOB_REQUEST_INTERVAL_MS = 10 * 60 * 1000; // 10 menit
const EPISODE_SCRAPE_DELAY_MS = 2 * 1000;      // 2 detik

async function promptBaseUrl() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('Masukkan base_url API Manager (misal: http://localhost:5000/api/v1): ', (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function getBaseUrl() {
    const baseUrl = await promptBaseUrl();
    if (!baseUrl) {
        console.error('base_url tidak boleh kosong. Keluar.');
        process.exit(1);
    }
    return baseUrl;
}

async function mainLoop(baseUrlToUse) {
    console.log('Worker Bot AnimeVerse dimulai...');
    console.log(`Menggunakan API Manager: ${baseUrlToUse}`);

    await initializeBrowser();

    while (true) {
        try {
            console.log('\n--- Meminta paket pekerjaan baru ---');
            const animeList = await requestJob();

            if (!animeList || animeList.length === 0) {
                console.log(`Tidak ada pekerjaan. Tidur selama ${JOB_REQUEST_INTERVAL_MS / 1000 / 60} menit.`);
                await sleep(JOB_REQUEST_INTERVAL_MS);
                continue;
            }

            console.log(`Memulai pemrosesan ${animeList.length} anime.`);

            for (const anime of animeList) {
                console.log(`\n--- Memproses Anime: [${anime.mal_id}] ${anime.title || 'Tanpa Judul'} ---`);

                if (!Array.isArray(anime.base_links) || anime.base_links.length === 0) {
                    console.log(`[Peringatan] Anime [${anime.mal_id}] tidak punya base_links valid. Melewati.`);
                    continue;
                }

                const baseUrl = anime.base_links[0].url;
                if (!baseUrl) {
                    console.log(`[Peringatan] Anime [${anime.mal_id}] punya base_links tapi URL kosong. Melewati.`);
                    continue;
                }
                console.log(`Menggunakan Base URL: ${baseUrl}`);

                let currentEpisodeNumber = 1;
                let foundLastEpisode = false;

                while (!foundLastEpisode) {
                    const cleanedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
                    const lastSlashIndex = cleanedBaseUrl.lastIndexOf('/');
                    const slug = cleanedBaseUrl.substring(lastSlashIndex + 1);
                    const domainPart = cleanedBaseUrl.substring(0, cleanedBaseUrl.lastIndexOf('/anime/'));
                    const episodeUrl = `${domainPart}/${slug}-episode-${currentEpisodeNumber}`;

                    console.log(`Mencoba scrape Episode ${currentEpisodeNumber} dari ${episodeUrl}`);

                    const scrapeResult = await scrapeEpisode(episodeUrl, currentEpisodeNumber);

                    if (!scrapeResult.success) {
                        console.log(`Episode ${currentEpisodeNumber} tidak ditemukan di ${episodeUrl}. Stop untuk anime ini.`);
                        foundLastEpisode = true;
                    } else {
                        console.log(`Berhasil scrape Episode ${currentEpisodeNumber}. Link: ${scrapeResult.links.length}`);
                        await submitResult(anime.mal_id, currentEpisodeNumber, scrapeResult.links);
                        await sleep(EPISODE_SCRAPE_DELAY_MS);
                        currentEpisodeNumber++;
                    }
                }
                console.log(`Selesai memproses anime [${anime.mal_id}].`);
            }

            console.log('\n--- Semua pekerjaan di paket ini selesai ---');
        } catch (error) {
            console.error('Error dalam loop utama bot:', error);
            await sleep(JOB_REQUEST_INTERVAL_MS / 5);
        }
    }
}

// Tangani sinyal keluar
process.on('SIGINT', async () => {
    console.log('\nSIGINT diterima. Menutup browser...');
    await closeBrowser();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('\nSIGTERM diterima. Menutup browser...');
    await closeBrowser();
    process.exit(0);
});

// Jalankan bot
(async () => {
    const baseUrlToUse = await getBaseUrl();
    setBaseUrl(baseUrlToUse); // <-- penting, konekkin ke apiClient
    await mainLoop(baseUrlToUse);
})();
