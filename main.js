// main.js
const readline = require('readline');
const { setBaseUrl, requestJob, submitResult } = require('./apiClient');
const { initializeBrowser, closeBrowser, scrapeEpisode } = require('./scraper');
const { sleep } = require('./utils');
const axios = require('axios');

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

// Fungsi pembantu untuk mengkonstruksi URL episode
function constructEpisodeUrl(baseAnimeUrl, episodeNumber, pattern) {
    const cleanedBaseAnimeUrl = baseAnimeUrl.endsWith('/') ? baseAnimeUrl.slice(0, -1) : baseAnimeUrl;

    // Asumsi baseAnimeUrl selalu memiliki format /anime/slug-anime/
    const domainPartMatch = cleanedBaseAnimeUrl.match(/^(https?:\/\/[^\/]+)/); // Hanya ambil domain
    if (!domainPartMatch) return null;
    const domain = domainPartMatch[1]; // e.g., https://v1.samehadaku.how

    const slugMatch = cleanedBaseAnimeUrl.match(/\/anime\/([^\/-]+(?:-[^\/-]+)*)\/?$/i);
    if (!slugMatch || !slugMatch[1]) return null;
    const animeSlug = slugMatch[1]; // e.g., busamen-gachi-fighter

    if (pattern === 'no_anime_path') {
        // Pola: https://domain.com/anime-slug-episode-N
        return `${domain}/${animeSlug}-episode-${episodeNumber}`;
    } else if (pattern === 'with_anime_path') {
        // Pola: https://domain.com/anime/anime-slug-episode-N
        return `${domain}/anime/${animeSlug}-episode-${episodeNumber}`;
    }
    return null;
}


// --- FUNGSI BARU: Mode Manual ---
async function manualMode(apiManagerBaseUrl) {
    console.log('\n--- Mode Manual Dimulai ---');
    await initializeBrowser();

    while (true) {
        const inputLink = await prompt('Masukkan link ANIME DASAR (tanpa /episode-N) atau link EPISODE SPESIFIK yang ingin di-scrape (ketik "exit" untuk keluar): ');
        if (inputLink.toLowerCase() === 'exit') break;
        if (!inputLink) {
            console.log('Link tidak boleh kosong.');
            continue;
        }

        const malIdInput = await prompt('Masukkan MAL ID anime (contoh: 54899) atau MAL ID/Episode ID (contoh: 68cf22407e6884c7bef1657e/54899): ');
        if (!malIdInput) {
            console.log('MAL ID atau format MAL ID/Episode ID tidak boleh kosong.');
            continue;
        }

        let mal_id;
        const malParts = malIdInput.split('/');
        if (malParts.length === 2 && !isNaN(parseInt(malParts[1], 10))) {
            mal_id = parseInt(malParts[1], 10);
        } else if (!isNaN(parseInt(malIdInput, 10))) {
            mal_id = parseInt(malIdInput, 10);
        } else {
            console.log('Format MAL ID tidak valid. Harap masukkan angka atau format HASH/MAL_ID.');
            continue;
        }

        if (isNaN(mal_id) || mal_id < 1) {
            console.log('MAL ID tidak valid.');
            continue;
        }

        const isSpecificEpisodeUrl = inputLink.toLowerCase().includes('-episode-');
        let baseAnimeUrlForConstruction = inputLink; // Ini akan jadi dasar untuk membuat URL episode
        let startEpisode = 1;
        let endEpisode = 0; // 0 berarti scrape sampai tidak ditemukan

        if (isSpecificEpisodeUrl) {
            const urlEpisodeMatch = inputLink.match(/episode-(\d+)/i);
            if (urlEpisodeMatch) {
                startEpisode = parseInt(urlEpisodeMatch[1], 10);
                endEpisode = startEpisode;
                // Dari URL episode, kita perlu mengkonstruksi kembali baseAnimeUrl
                baseAnimeUrlForConstruction = inputLink.replace(/-episode-\d+\/?$/, '/'); // Hapus episode part, tambahkan /
                console.log(`[Manual] Terdeteksi URL episode spesifik. Hanya akan scrape Episode ${startEpisode}. Base URL untuk konstruksi: ${baseAnimeUrlForConstruction}`);
            } else {
                console.log('[Peringatan] URL terdeteksi sebagai episode spesifik tetapi nomor episode tidak dapat diekstrak. Akan mencoba scrape hanya satu episode.');
                endEpisode = startEpisode;
            }
        } else {
            console.log('[Manual] Terdeteksi URL dasar anime. Akan mencoba scrape semua episode.');
            baseAnimeUrlForConstruction = inputLink; // URL dasar adalah inputnya
            const totalEpisodesInput = await prompt('Masukkan total episode anime (kosongkan jika tidak tahu atau ingin scrape sampai tidak ditemukan): ');
            if (totalEpisodesInput && !isNaN(parseInt(totalEpisodesInput, 10))) {
                endEpisode = parseInt(totalEpisodesInput, 10);
                console.log(`[Manual] Akan scrape dari Episode 1 hingga Episode ${endEpisode}.`);
            } else {
                console.log('[Manual] Akan scrape mulai dari Episode 1 sampai episode tidak ditemukan.');
            }
        }

        // Validasi baseAnimeUrlForConstruction setelah penyesuaian
        if (!baseAnimeUrlForConstruction || !baseAnimeUrlForConstruction.match(/^(https?:\/\/[^\/]+\/anime\/[^\/]+\/?)$/i)) {
            console.error('[Manual] Base URL anime yang terkonstruksi tidak valid. Contoh format: https://domain.com/anime/slug-anime/');
            continue;
        }


        let currentEpisodeToScrape = startEpisode;
        let foundLastEpisode = false;

        while (!foundLastEpisode && (endEpisode === 0 || currentEpisodeToScrape <= endEpisode)) {
            let episodeUrlToScrape = null;
            let scrapeResult = { success: false };

            // --- BARU: Coba Pola A (tanpa /anime/) ---
            episodeUrlToScrape = constructEpisodeUrl(baseAnimeUrlForConstruction, currentEpisodeToScrape, 'no_anime_path');
            if (episodeUrlToScrape) {
                console.log(`\n[Manual] Mencoba Pola A: ${episodeUrlToScrape}`);
                scrapeResult = await scrapeEpisode(episodeUrlToScrape, currentEpisodeToScrape);
            }

            // --- BARU: Jika Pola A gagal, coba Pola B (dengan /anime/) ---
            if (!scrapeResult.success) {
                episodeUrlToScrape = constructEpisodeUrl(baseAnimeUrlForConstruction, currentEpisodeToScrape, 'with_anime_path');
                if (episodeUrlToScrape) {
                    console.log(`[Manual] Pola A gagal. Mencoba Pola B: ${episodeUrlToScrape}`);
                    scrapeResult = await scrapeEpisode(episodeUrlToScrape, currentEpisodeToScrape);
                }
            }


            if (!scrapeResult.success) {
                console.log(`[Manual] Episode ${currentEpisodeToScrape} tidak ditemukan di kedua pola URL atau gagal scrape. Menghentikan scraping untuk anime ini.`);
                foundLastEpisode = true;
            } else {
                console.log(`[Manual] Berhasil scrape Episode ${currentEpisodeToScrape}. Ditemukan ${scrapeResult.links.length} link.`);
                await submitResult(mal_id, currentEpisodeToScrape, scrapeResult.links);
                console.log(`[Manual] Link berhasil dikirim ke database untuk MAL ID ${mal_id} Ep ${currentEpisodeToScrape}.`);
                await sleep(EPISODE_SCRAPE_DELAY_MS);
                currentEpisodeToScrape++;
            }
        }
        console.log(`[Manual] Selesai memproses anime MAL ID ${mal_id} secara manual.`);
    }
    console.log('--- Mode Manual Selesai ---');
    await closeBrowser();
}

async function mainLoop(apiManagerBaseUrl) {
    console.log('Worker Bot AnimeVerse dimulai...');
    console.log(`Menggunakan API Manager: ${apiManagerBaseUrl}`);

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

                let totalAnimeEpisodes = anime.episodes || 0;
                if (totalAnimeEpisodes === 0) {
                    try {
                        console.log(`[Bot] Mengambil total episode dari backend untuk MAL ID ${anime.mal_id}...`);
                        const response = await axios.get(`${apiManagerBaseUrl}/anime/${anime.mal_id}/full`);
                        if (response.data?.data?.episodes) {
                            totalAnimeEpisodes = response.data.data.episodes;
                            console.log(`[Bot] Total episode ditemukan: ${totalAnimeEpisodes}`);
                        } else {
                            console.log(`[Bot] Total episode tidak ditemukan di backend. Akan scrape sampai tidak ditemukan.`);
                            totalAnimeEpisodes = 9999;
                        }
                    } catch (apiError) {
                        console.warn(`[Bot] Gagal mengambil total episode dari backend untuk MAL ID ${anime.mal_id}: ${apiError.message}. Akan scrape sampai tidak ditemukan.`);
                        totalAnimeEpisodes = 9999;
                    }
                }

                let currentEpisodeNumber = 1;
                let foundLastEpisode = false;

                while (!foundLastEpisode && (totalAnimeEpisodes === 9999 || currentEpisodeNumber <= totalAnimeEpisodes)) {
                    let episodeUrlToScrape = null;
                    let scrapeResult = { success: false };

                    // --- BARU: Coba Pola A (tanpa /anime/) ---
                    episodeUrlToScrape = constructEpisodeUrl(baseUrl, currentEpisodeNumber, 'no_anime_path');
                    if (episodeUrlToScrape) {
                        console.log(`\n[Bot] Mencoba Pola A: ${episodeUrlToScrape}`);
                        scrapeResult = await scrapeEpisode(episodeUrlToScrape, currentEpisodeNumber);
                    }

                    // --- BARU: Jika Pola A gagal, coba Pola B (dengan /anime/) ---
                    if (!scrapeResult.success) {
                        episodeUrlToScrape = constructEpisodeUrl(baseUrl, currentEpisodeNumber, 'with_anime_path');
                        if (episodeUrlToScrape) {
                            console.log(`[Bot] Pola A gagal. Mencoba Pola B: ${episodeUrlToScrape}`);
                            scrapeResult = await scrapeEpisode(episodeUrlToScrape, currentEpisodeNumber);
                        }
                    }

                    if (!scrapeResult.success) {
                        console.log(`Episode ${currentEpisodeNumber} tidak ditemukan di kedua pola URL atau gagal scrape. Menghentikan scraping untuk anime ini.`);
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
        await manualMode(baseUrlToUse);
    } else {
        await mainLoop(baseUrlToUse);
    }
})();