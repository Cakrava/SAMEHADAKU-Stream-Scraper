// main.js
const readline = require('readline');
const { setBaseUrl, requestJob, submitResult } = require('./apiClient');
const { initializeBrowser, closeBrowser, scrapeEpisode } = require('./scraper'); // Scraper yang diupdate
const { sleep } = require('./utils');

const JOB_REQUEST_INTERVAL_MS = 10 * 60 * 1000; // 10 menit
const EPISODE_SCRAPE_DELAY_MS = 2 * 1000;      // 2 detik

async function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function getBaseUrl() {
    const baseUrl = await prompt('Masukkan base_url API Manager (misal: http://localhost:5000/api/v1): ');
    if (!baseUrl) {
        console.error('base_url tidak boleh kosong. Keluar.');
        process.exit(1);
    }
    return baseUrl;
}

// --- FUNGSI BARU: Manual Mode ---
async function manualMode() {
    console.log('\n--- Mode Manual Dimulai ---');
    await initializeBrowser(); // Inisialisasi browser untuk scraping manual

    while (true) {
        const episodeUrl = await prompt('Masukkan link episode yang ingin di-scrape (ketik "exit" untuk keluar): ');
        if (episodeUrl.toLowerCase() === 'exit') break;
        if (!episodeUrl) {
            console.log('Link episode tidak boleh kosong.');
            continue;
        }

        const malIdInput = await prompt('Masukkan MAL ID anime (contoh: 54899) atau MAL ID/Episode ID (contoh: 68cf22407e6884c7bef1657e/54899): ');
        if (!malIdInput) {
            console.log('MAL ID atau format MAL ID/Episode ID tidak boleh kosong.');
            continue;
        }

        let mal_id;
        let episode_number_for_db; // Ini adalah nomor episode yang akan dikirim ke DB

        // Logika untuk memparse malIdInput
        // Jika formatnya 'HASH/MAL_ID'
        const parts = malIdInput.split('/');
        if (parts.length === 2 && !isNaN(parseInt(parts[1], 10))) {
            mal_id = parseInt(parts[1], 10);
            // Coba ekstrak nomor episode dari URL jika tidak ada di input malIdInput
            const urlEpisodeMatch = episodeUrl.match(/episode-(\d+)/i);
            if (urlEpisodeMatch) {
                episode_number_for_db = parseInt(urlEpisodeMatch[1], 10);
            } else {
                episode_number_for_db = parseInt(await prompt('Gagal mengekstrak nomor episode dari URL. Masukkan nomor episode secara manual: '), 10);
                if (isNaN(episode_number_for_db)) {
                    console.log('Nomor episode harus berupa angka.');
                    continue;
                }
            }
        } else if (!isNaN(parseInt(malIdInput, 10))) {
            mal_id = parseInt(malIdInput, 10);
            // Pastikan episode number diambil dari URL jika hanya MAL ID saja yang diberikan
            const urlEpisodeMatch = episodeUrl.match(/episode-(\d+)/i);
            if (urlEpisodeMatch) {
                episode_number_for_db = parseInt(urlEpisodeMatch[1], 10);
            } else {
                episode_number_for_db = parseInt(await prompt('Gagal mengekstrak nomor episode dari URL. Masukkan nomor episode secara manual: '), 10);
                if (isNaN(episode_number_for_db)) {
                    console.log('Nomor episode harus berupa angka.');
                    continue;
                }
            }
        } else {
            console.log('Format MAL ID tidak valid. Harap masukkan angka atau format HASH/MAL_ID.');
            continue;
        }

        // Pastikan episode_number_for_db valid
        if (isNaN(episode_number_for_db) || episode_number_for_db < 1) {
            console.log('Nomor episode tidak valid atau tidak dapat ditentukan. Harap masukkan URL yang jelas.');
            continue;
        }


        console.log(`\n[Manual] Memulai scrape untuk MAL ID: ${mal_id}, Episode: ${episode_number_for_db} dari URL: ${episodeUrl}`);

        try {
            const scrapeResult = await scrapeEpisode(episodeUrl, episode_number_for_db); // Gunakan episode_number_for_db untuk logging di scraper

            if (scrapeResult.success) {
                console.log(`[Manual] Berhasil scrape Episode ${episode_number_for_db}. Ditemukan ${scrapeResult.links.length} link.`);
                // Kirim hasil ke backend
                await submitResult(mal_id, episode_number_for_db, scrapeResult.links);
                console.log(`[Manual] Link berhasil dikirim ke database untuk MAL ID ${mal_id} Ep ${episode_number_for_db}.`);
            } else {
                console.log(`[Manual] Gagal scrape Episode ${episode_number_for_db} dari ${episodeUrl}.`);
            }
        } catch (error) {
            console.error(`[Manual] Error saat scraping manual:`, error);
        }
        await sleep(EPISODE_SCRAPE_DELAY_MS); // Beri jeda antar scraping manual
    }
    console.log('--- Mode Manual Selesai ---');
    await closeBrowser(); // Tutup browser setelah mode manual selesai
}

async function mainLoop(baseUrlToUse) {
    console.log('Worker Bot AnimeVerse dimulai...');
    console.log(`Menggunakan API Manager: ${baseUrlToUse}`);

    await initializeBrowser(); // Inisialisasi browser untuk mode bot

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

                // Ambil total episode dari anime obj jika ada
                const totalAnimeEpisodes = anime.episodes || 999; // Default tinggi jika tidak diketahui

                let currentEpisodeNumber = 1;
                let foundLastEpisode = false;

                while (!foundLastEpisode && currentEpisodeNumber <= totalAnimeEpisodes) { // Batasi berdasarkan total episode
                    const cleanedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
                    const lastSlashIndex = cleanedBaseUrl.lastIndexOf('/');
                    const slug = cleanedBaseUrl.substring(lastSlashIndex + 1);
                    const domainPart = cleanedBaseUrl.substring(0, cleanedBaseUrl.indexOf('/anime/')); // Perbaiki ini jika struktur URLnya `/domain.com/anime/slug`

                    // Rekonstruksi URL episode:
                    // Contoh: https://v1.samehadaku.how/anime/slug-anime-episode-1
                    // Perlu lebih cerdas dalam mengkonstruksi URL episode dari base_link
                    // Asumsi base_link: https://v1.samehadaku.how/anime/slug-anime/
                    // Maka episode: https://v1.samehadaku.how/anime/slug-anime-episode-1

                    const animeSlug = cleanedBaseUrl.substring(cleanedBaseUrl.lastIndexOf('/anime/') + 7, cleanedBaseUrl.lastIndexOf('/'));
                    const episodeUrl = `${domainPart}/anime/${animeSlug}-episode-${currentEpisodeNumber}`;


                    console.log(`Mencoba scrape Episode ${currentEpisodeNumber} dari ${episodeUrl}`);

                    const scrapeResult = await scrapeEpisode(episodeUrl, currentEpisodeNumber);

                    if (!scrapeResult.success) {
                        console.log(`Episode ${currentEpisodeNumber} tidak ditemukan di ${episodeUrl} atau gagal. Stop untuk anime ini.`);
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
    setBaseUrl(baseUrlToUse);

    const mode = await prompt('Jalankan bot dalam mode otomatis (bot) atau manual (manual)? ');

    if (mode.toLowerCase() === 'manual') {
        await manualMode();
    } else {
        await mainLoop(baseUrlToUse);
    }
})(); 