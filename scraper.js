// scraper.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { sleep } = require('./utils'); // Asumsi utils.js ada dengan fungsi sleep

puppeteer.use(StealthPlugin());

let browserInstance = null; // Menyimpan instance browser global

// Map prioritas server (angka lebih kecil = prioritas lebih tinggi)
const SERVER_PRIORITY = {
    'Pucuk': 1,
    'Nakama': 2,
    'Premium': 3,
    'Vidhide': 4,
    'Mega': 5,
    'Blogspot': 6,
    // BARU: Server default yang tidak terdaftar akan memiliki prioritas sangat rendah
    'DefaultServer': 99 // Nama untuk server yang tidak dikenali
};

// Urutan prioritas server untuk PEMILIHAN AKHIR server output
const OUTPUT_SERVER_PRIORITY_ORDER = ['Pucuk', 'Nakama', 'Premium', 'Vidhide', 'Mega', 'Blogspot'];
const TARGET_RESOLUTIONS_PER_SERVER = ['1080p', '720p', '480p'];
const TARGET_NUM_PRIMARY_SERVERS = 2; // Target 2 server utama
// BARU: Minimal pool link yang harus dikumpulkan di Fase 1 sebelum berhenti mengklik
// Ini harus cukup untuk mengisi target 6 link + potensi tambalan dari server lain
// Misalnya, target 6 link (2 server x 3 resolusi) + 3-6 link ekstra untuk penambal dari server alternatif
const MIN_LINKS_FOR_SELECTION_POOL = TARGET_NUM_PRIMARY_SERVERS * TARGET_RESOLUTIONS_PER_SERVER.length + TARGET_RESOLUTIONS_PER_SERVER.length; // 6 + 3 = 9 link
const MAX_SERVER_CLICKS_AT_ONCE = 5; // BARU: Batasi jumlah server berbeda yang akan diklik di Fase 1 (untuk efisiensi)

/**
 * Menginisialisasi browser Puppeteer.
 * @returns {Promise<Browser>} Instance browser.
 */
async function initializeBrowser() {
    if (!browserInstance) {
        console.log('[Scraper] Meluncurkan browser...');
        browserInstance = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-notifications',
                '--disable-gpu',
                '--no-zygote',
                '--disable-accelerated-2d-canvas',
                '--disable-dev-shm-usage',
                '--single-process'
            ]
        });
        console.log('[Scraper] Browser berhasil diluncurkan.');
    }
    return browserInstance;
}

/**
 * Menutup browser Puppeteer.
 */
async function closeBrowser() {
    if (browserInstance) {
        console.log('[Scraper] Menutup browser...');
        await browserInstance.close();
        browserInstance = null;
        console.log('[Scraper] Browser ditutup.');
    }
}

/**
 * Meng-scrape satu episode anime untuk link video streaming dengan logika prioritas.
 * @param {string} url - URL halaman episode.
 * @param {number} episodeNumber - Nomor episode.
 * @returns {Promise<Object>} Objek hasil scraping.
 */
async function scrapeEpisode(url, episodeNumber) {
    let page;
    // Map untuk menyimpan semua link yang berhasil diekstrak dari server yang diklik
    // Format: Map<ServerName, Map<Quality, { server, quality, url, priority }>>
    const availableLinksMap = new Map();
    const clickedOptionIds = new Set(); // Melacak ID opsi DOM yang sudah diklik untuk menghindari klik ganda
    const clickedServerNamesInPhase1 = new Set(); // BARU: Melacak nama server yang sudah diklik di Fase 1

    try {
        const browser = await initializeBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        console.log(`[Scraper] Mengunjungi URL: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const serverSelector = 'div.east_player_option';
        try {
            console.log(`[Scraper] Menunggu selector server: '${serverSelector}' selama 20 detik.`);
            await page.waitForSelector(serverSelector, { timeout: 20000 });
            console.log(`[Scraper] Selector server ditemukan.`);
        } catch (e) {
            console.warn(`[Scraper] Episode ${episodeNumber} (${url}) tidak valid atau tombol server tidak ditemukan.`);
            if (page) await page.close();
            return { success: false, links: [] };
        }

        const initialServerOptionHandles = await page.$$(serverSelector);
        if (initialServerOptionHandles.length === 0) {
            console.warn(`[Scraper] Tidak ada opsi server yang ditemukan di halaman ${url}.`);
            if (page) await page.close();
            return { success: false, links: [] };
        }

        // Kumpulkan detail semua opsi server dari DOM (tanpa mengklik dulu)
        const allOptionDetails = [];
        for (const handle of initialServerOptionHandles) {
            const { id, textContent } = await page.evaluate(el => ({
                id: el.id,
                textContent: el.textContent.trim()
            }), handle);
            const serverText = textContent;
            const serverMatch = serverText.match(/^(.+?)(?:\s*(\d{3,4}p))?$/i);
            // BARU: Ubah baseServerName menjadi 'DefaultServer' jika tidak dikenal
            let baseServerName = serverMatch && serverMatch[1] ? serverMatch[1].trim() : 'DefaultServer';
            if (!SERVER_PRIORITY.hasOwnProperty(baseServerName)) {
                baseServerName = 'DefaultServer'; // Fallback ke nama default jika tidak ada di SERVER_PRIORITY
            }
            const quality = serverMatch && serverMatch[2] ? serverMatch[2].trim() : 'Unknown';

            allOptionDetails.push({
                id,
                serverText,
                baseServerName,
                quality,
                priority: SERVER_PRIORITY[baseServerName] || SERVER_PRIORITY['DefaultServer'] // Gunakan prioritas default
            });
        }
        // Urutkan opsi agar yang lebih prioritas diklik lebih dulu
        allOptionDetails.sort((a, b) => a.priority - b.priority);

        console.log(`[Scraper] Memulai fase ekstraksi link dari server...`);

        // --- FASE 1: Ekstraksi Link Cerdas (Efisiensi Klik dengan Fallback) ---
        let currentLinksInPool = 0; // Total link unik yang berhasil diekstrak di pool
        let serverClicksCount = 0; // BARU: Menghitung berapa server berbeda yang sudah diklik

        // Iterasi melalui opsi server yang diurutkan (prioritas tinggi dulu)
        for (const option of allOptionDetails) {
            // Hentikan mengklik jika sudah punya cukup link atau sudah mengklik terlalu banyak server
            if (currentLinksInPool >= MIN_LINKS_FOR_SELECTION_POOL && clickedServerNamesInPhase1.size >= MAX_SERVER_CLICKS_AT_ONCE) {
                console.log(`[Scraper] Cukup link (${currentLinksInPool}) dari ${clickedServerNamesInPhase1.size} server telah diekstrak. Menghentikan klik fase 1.`);
                break;
            }
            if (clickedOptionIds.has(option.id)) { // Pastikan tidak mengklik opsi DOM yang sama dua kali
                continue;
            }
            if (clickedServerNamesInPhase1.has(option.baseServerName) && currentLinksInPool >= MIN_LINKS_FOR_SELECTION_POOL) {
                // Jika server ini sudah diklik, dan kita sudah punya cukup link,
                // kita tidak perlu lagi mengklik opsi resolusi lain dari server ini.
                // Ini untuk menghemat klik jika sudah cukup data.
                continue;
            }


            try {
                const currentOptionHandle = await page.$(`#${option.id}`);
                if (!currentOptionHandle) {
                    console.warn(`[Scraper] Tombol "${option.serverText}" (ID: ${option.id}) tidak dapat ditemukan kembali. Melewati.`);
                    continue;
                }

                console.log(`[Scraper] Mengklik opsi: "${option.serverText}"`);
                await currentOptionHandle.click();
                clickedOptionIds.add(option.id); // Tandai opsi DOM ini sudah diklik
                if (!clickedServerNamesInPhase1.has(option.baseServerName)) { // Baru pertama kali klik server ini di fase 1
                    clickedServerNamesInPhase1.add(option.baseServerName);
                    serverClicksCount++; // Hitung klik server yang berbeda
                }
                await sleep(5000); // Penundaan per klik

                const iframeSrcs = await page.evaluate(() => {
                    const iframes = Array.from(document.querySelectorAll('iframe'));
                    return iframes.map(iframe => iframe.src).filter(src => src);
                });

                const validIframeSrc = iframeSrcs.find(src =>
                    src && !src.includes('facebook.com') && !src.includes('fb.watch') &&
                    !src.includes('sso.ruangotaku.com') && !src.includes('dtscout.com') &&
                    !src.includes('crwdcntrl.net') && !src.includes('ads.google.com') &&
                    !src.includes('googlesyndication.com') && !src.includes('adserver') &&
                    !src.includes('popads') && !src.includes('popunder') &&
                    !src.includes('tracker') && !src.includes('analytics')
                );

                if (validIframeSrc) {
                    if (!availableLinksMap.has(option.baseServerName)) {
                        availableLinksMap.set(option.baseServerName, new Map());
                    }
                    if (!availableLinksMap.get(option.baseServerName).has(option.quality)) {
                        availableLinksMap.get(option.baseServerName).set(option.quality, {
                            server: option.baseServerName,
                            quality: option.quality,
                            url: validIframeSrc,
                            priority: option.priority
                        });
                        currentLinksInPool++;
                        console.log(`[Scraper] Ditemukan link valid: ${option.baseServerName} - ${option.quality}`);
                    } else {
                        console.log(`[Scraper] Link untuk ${option.baseServerName} - ${option.quality} sudah ada di pool.`);
                    }
                } else {
                    console.log(`[Scraper] Tidak ada link video valid ditemukan untuk opsi "${option.serverText}".`);
                }

            } catch (error) {
                console.error(`[Scraper] Error saat memproses opsi "${option.serverText}":`, error.message);
            }
        }

        console.log(`[Scraper] Fase ekstraksi selesai. Total link di pool: ${currentLinksInPool}. Total server berbeda diklik: ${clickedServerNamesInPhase1.size}`);


        // --- FASE 2: Seleksi & Penambalan Link Output ---
        const finalStreamLinksOutput = [];
        const selectedPrimaryServers = []; // Server yang akan jadi 2 server utama di output
        const occupiedQualities = new Map(); // Map<ServerName, Set<Quality>> untuk slot yang sudah terisi di output final

        // 2.1: Pilih 2 server utama berprioritas tertinggi yang berhasil memberikan link di Fase 1
        for (const serverName of OUTPUT_SERVER_PRIORITY_ORDER) {
            if (availableLinksMap.has(serverName) && selectedPrimaryServers.length < TARGET_NUM_PRIMARY_SERVERS) {
                selectedPrimaryServers.push(serverName);
                occupiedQualities.set(serverName, new Set()); // Inisialisasi slot terisi untuk server ini
            }
            if (selectedPrimaryServers.length === TARGET_NUM_PRIMARY_SERVERS) break;
        }
        console.log(`[Scraper] Server utama terpilih untuk output: ${selectedPrimaryServers.join(', ')}`);


        // 2.2: Isi resolusi untuk 2 server utama yang terpilih, dan identifikasi slot yang hilang
        const missingSlots = []; // List of { server: primaryServerName, quality: missingQuality }

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

        // 2.3: Proses Penambalan (Patching) untuk slot yang hilang
        // Prioritaskan 1080p dulu, lalu 720p, lalu 480p
        missingSlots.sort((a, b) => {
            const qualityOrder = { '1080p': 1, '720p': 2, '480p': 3 };
            return (qualityOrder[a.quality] || 99) - (qualityOrder[b.quality] || 99);
        });

        for (const missingSlot of missingSlots) {
            const { server: targetPrimaryServer, quality: missingQuality } = missingSlot;
            console.log(`[Scraper] Mencoba menambal slot: ${targetPrimaryServer} - ${missingQuality}`);

            let patchLinkFound = null;

            // Prioritas penambalan dari server lain (bukan dari server utama itu sendiri)
            for (const patchServerName of OUTPUT_SERVER_PRIORITY_ORDER) {
                if (patchServerName === targetPrimaryServer) continue; // Jangan menambal dari diri sendiri

                const hasMissingQuality = availableLinksMap.get(patchServerName)?.has(missingQuality);

                if (hasMissingQuality) {
                    // Hanya ambil jika server patch ini belum mengisi slot kualitas ini
                    if (!occupiedQualities.get(patchServerName)?.has(missingQuality)) {
                        patchLinkFound = availableLinksMap.get(patchServerName).get(missingQuality);
                        console.log(`[Scraper] Penambal ditemukan dari server prioritas: ${patchServerName} untuk ${missingQuality}.`);
                        break; // Ambil yang paling prioritas pertama yang ditemukan
                    }
                }
            }

            // BARU: Tambahan untuk skenario "seadanya" jika dari OUTPUT_SERVER_PRIORITY_ORDER tidak ada
            if (!patchLinkFound && currentLinksInPool > 0) { // Jika belum ada penambal dan ada link di pool
                console.log(`[Scraper] Mencari penambal 'seadanya' untuk ${missingQuality} dari server yang tidak diutamakan...`);
                // Kumpulkan semua link yang tersedia untuk kualitas yang hilang, dari server yang belum mengisi slot ini
                const fallbackLinks = [];
                for (const [sName, sLinks] of availableLinksMap.entries()) {
                    if (sName === targetPrimaryServer) continue; // Jangan dari server utama yang sedang ditambal

                    // Periksa apakah server ini sudah mengisi slot kualitas ini
                    if (occupiedQualities.has(sName) && occupiedQualities.get(sName).has(missingQuality)) {
                        continue; // Skip jika server ini sudah menyediakan link untuk kualitas ini
                    }

                    const link = sLinks.get(missingQuality);
                    if (link) {
                        fallbackLinks.push(link);
                    }
                }
                // Urutkan fallbackLinks berdasarkan prioritas server
                fallbackLinks.sort((a, b) => (SERVER_PRIORITY[a.server] || SERVER_PRIORITY['DefaultServer']) - (SERVER_PRIORITY[b.server] || SERVER_PRIORITY['DefaultServer']));

                if (fallbackLinks.length > 0) {
                    patchLinkFound = fallbackLinks[0]; // Ambil yang paling prioritas
                    console.log(`[Scraper] Penambal 'seadanya' ditemukan dari ${patchLinkFound.server} untuk ${missingQuality}.`);
                }
            }


            if (patchLinkFound) {
                finalStreamLinksOutput.push(patchLinkFound);
                // Tandai kualitas ini sudah terisi dari server patch
                if (!occupiedQualities.has(patchLinkFound.server)) {
                    occupiedQualities.set(patchLinkFound.server, new Set());
                }
                occupiedQualities.get(patchLinkFound.server).add(patchLinkFound.quality);
            } else {
                console.warn(`[Scraper] Gagal menemukan link penambal untuk ${targetPrimaryServer} - ${missingQuality}. Slot dibiarkan kosong.`);
            }
        }

        // --- Finalisasi: Urutkan output untuk konsistensi ---
        finalStreamLinksOutput.sort((a, b) => {
            const serverPriorityA = SERVER_PRIORITY[a.server] || SERVER_PRIORITY['DefaultServer'];
            const serverPriorityB = SERVER_PRIORITY[b.server] || SERVER_PRIORITY['DefaultServer'];
            if (serverPriorityA !== serverPriorityB) {
                return serverPriorityA - serverPriorityB;
            }
            const qualityOrder = { '1080p': 1, '720p': 2, '480p': 3 };
            return (qualityOrder[a.quality] || 99) - (qualityOrder[b.quality] || 99);
        });

        if (page) await page.close();
        return { success: true, links: finalStreamLinksOutput };

    } catch (error) {
        console.error(`[Scraper] Error umum saat scraping episode ${episodeNumber} (${url}):`, error.message);
        if (page) await page.close();
        return { success: false, links: [] };
    }
}

module.exports = {
    initializeBrowser,
    closeBrowser,
    scrapeEpisode
};