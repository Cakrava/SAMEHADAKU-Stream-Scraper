// main.js
const readline = require('readline');
const { setBaseUrl, requestJob, submitResult } = require('./apiClient');
const { initializeBrowser, closeBrowser, scrapeEpisode } = require('./scraper');
const { sleep } = require('./utils');

const JOB_REQUEST_INTERVAL_MS = 10 * 60 * 1000; // 10 menit
const EPISODE_SCRAPE_DELAY_MS = 2 * 1000;      // 2 detik

// Helper untuk membaca input dari CLI
async function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

async function promptBaseUrl() {
    return askQuestion('Masukkan base_url API Manager (misal: http://localhost:5000/api/v1): ');
}

async function getBaseUrl() {
    const baseUrl = await promptBaseUrl();
    if (!baseUrl) {
        console.error('base_url tidak boleh kosong. Keluar.');
        process.exit(1);
    }
    return baseUrl;
}

// --- FUNGSI BARU: Manual Mode ---
async function manualModeLoop() {
    console.log('\n--- Mode Manual Dimulai ---');
    console.log('Anda akan diminta memasukkan URL episode dan MAL ID secara manual.');

    while (true) {
        const episodeUrl = await askQuestion('Masukkan URL halaman episode (misal: https://v1.samehadaku.how/anime-slug-episode-1): ');
        if (!episodeUrl) {
            console.log('URL episode tidak boleh kosong. Ketik "exit" untuk keluar dari mode manual.');
            const exitCommand = await askQuestion('Ketik "exit" untuk keluar, atau tekan Enter untuk mencoba lagi: ');
            if (exitCommand.toLowerCase() === 'exit') break;
            continue;
        }

        const malIdInput = await askQuestion('Masukkan MAL ID anime (misal: 54899) atau MAL ID + UID (misal: 68cf22407e6884c7bef1657e/54899): ');
        if (!malIdInput) {
            console.log('MAL ID tidak boleh kosong. Ketik "exit" untuk keluar dari mode manual.');
            const exitCommand = await askQuestion('Ketik "exit" untuk keluar, atau tekan Enter untuk mencoba lagi: ');
            if (exitCommand.toLowerCase() === 'exit') break;
            continue;
        }

        let animeMalId;
        let episodeNumber;
        let submitMalId;

        // Mendapatkan episodeNumber dari URL
        const episodeMatch = episodeUrl.match(/-episode-(\d+)(?:[/]|$)/i);
        if (episodeMatch && episodeMatch[1]) {
            episodeNumber = parseInt(episodeMatch[1], 10);
        } else {
            console.error('Gagal mengekstrak nomor episode dari URL. Pastikan format URL benar.');
            continue;
        }

        // Memproses input MAL ID yang mungkin memiliki UID
        if (malIdInput.includes('/')) {
            const parts = malIdInput.split('/');
            // UID diabaikan di sini, kita hanya perlu MAL ID
            submitMalId = parseInt(parts[1], 10);
            animeMalId = parseInt(parts[1], 10); // Untuk internal bot
        } else {
            submitMalId = parseInt(malIdInput, 10);
            animeMalId = parseInt(malIdInput, 10); // Untuk internal bot
        }

        if (isNaN(animeMalId) || isNaN(episodeNumber)) {
            console.error('MAL ID atau Nomor Episode tidak valid. Pastikan Anda memasukkan angka.');
            continue;
        }

        console.log(`\n--- Memulai Scraping Manual ---`);
        console.log(`URL: ${episodeUrl}`);
        console.log(`Anime MAL ID: ${animeMalId}`);
        console.log(`Episode Number: ${episodeNumber}`);

        try {
            const scrapeResult = await scrapeEpisode(episodeUrl, episodeNumber);

            if (scrapeResult.success) {
                console.log(`Berhasil scrape Episode ${episodeNumber}. Ditemukan ${scrapeResult.links.length} link.`);
                // Mengirimkan hasil ke backend
                if (submitMalId) { // Pastikan submitMalId valid
                    await submitResult(submitMalId, episodeNumber, scrapeResult.links);
                    console.log('Hasil scraping manual berhasil dikirim ke backend.');
                } else {
                    console.error('MAL ID tidak ditemukan untuk submit. Hasil tidak dikirim ke backend.');
                }
            } else {
                console.error(`Gagal scrape Episode ${episodeNumber}.`);
            }
        } catch (error) {
            console.error('Error saat scraping manual:', error);
        }

        const continuePrompt = await askQuestion('Scraping selesai. Scrape episode lain secara manual? (ya/tidak): ');
        if (continuePrompt.toLowerCase() !== 'ya') {
            break;
        }
    }
    console.log('\n--- Keluar dari Mode Manual ---');
}

// mainLoop yang sudah ada (Bot Mode)
async function mainLoop(baseUrlToUse) {
    console.log('Worker Bot AnimeVerse dimulai dalam Mode Otomatis...');
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

                // Mengambil base_url pertama dari array base_links
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
                    // Logika untuk membuat URL episode dari base_url anime
                    // Asumsi: baseUrl adalah 'https://v1.samehadaku.how/anime/anime-slug/'
                    // Maka episodeUrl akan jadi 'https://v1.samehadaku.how/anime-slug-episode-1'
                    const lastSlashIndex = cleanedBaseUrl.lastIndexOf('/');
                    const slug = cleanedBaseUrl.substring(lastSlashIndex + 1);
                    const domainPart = cleanedBaseUrl.substring(0, cleanedBaseUrl.lastIndexOf('/anime/')); // Mengambil 'https://v1.samehadaku.how'
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
    // Selalu minta Base URL API Manager dulu
    const baseUrlToUse = await getBaseUrl();
    setBaseUrl(baseUrlToUse); // Set Base URL untuk apiClient

    // Tanyakan mode operasi
    const botModeAnswer = await askQuestion('Jalankan bot dalam Mode Otomatis? (ya/tidak): ');

    await initializeBrowser(); // Inisialisasi browser sekali di awal

    if (botModeAnswer.toLowerCase() === 'ya') {
        await mainLoop(baseUrlToUse); // Masuk ke Bot Mode
    } else {
        await manualModeLoop(); // Masuk ke Manual Mode
    }

    await closeBrowser(); // Tutup browser saat semua mode selesai
    process.exit(0);
})();