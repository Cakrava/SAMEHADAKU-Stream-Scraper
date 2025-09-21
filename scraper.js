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
    'Unknown': 99 // Untuk server yang tidak terdaftar
};

// Urutan prioritas server untuk PEMILIHAN AKHIR server output
const OUTPUT_SERVER_PRIORITY_ORDER = ['Pucuk', 'Nakama', 'Premium', 'Vidhide', 'Mega', 'Blogspot'];
const TARGET_RESOLUTIONS_PER_SERVER = ['1080p', '720p', '480p'];
const TARGET_NUM_PRIMARY_SERVERS = 2; // Target 2 server utama
const MIN_LINKS_FOR_PATCHING_POOL = TARGET_NUM_PRIMARY_SERVERS * TARGET_RESOLUTIONS_PER_SERVER.length + 3; // Minimal 6 link (target) + 3 (untuk patch) = 9 link sebagai pool ekstraksi minimal

/**
 * Menginisialisasi browser Puppeteer.
 * @returns {Promise<Browser>} Instance browser.
 */
async function initializeBrowser() {
    if (!browserInstance) {
        console.log('[Scraper] Meluncurkan browser...');
        browserInstance = await puppeteer.launch({
            headless: 'new', // Set ke 'new' atau 'true' (default)
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
    const clickedServerNames = new Set(); // Melacak server yang sudah diklik untuk efisiensi

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
            const baseServerName = serverMatch && serverMatch[1] ? serverMatch[1].trim() : 'Unknown';
            const quality = serverMatch && serverMatch[2] ? serverMatch[2].trim() : 'Unknown';

            allOptionDetails.push({
                id,
                serverText,
                baseServerName,
                quality,
                priority: SERVER_PRIORITY[baseServerName] || SERVER_PRIORITY['Unknown']
            });
        }
        // Urutkan opsi agar yang lebih prioritas diklik lebih dulu
        allOptionDetails.sort((a, b) => a.priority - b.priority);

        console.log(`[Scraper] Memulai fase ekstraksi link dari server prioritas...`);

        // --- FASE 1: Ekstraksi Link Prioritas Tinggi (Efisiensi Klik) ---
        // Kita akan mengklik server berdasarkan prioritas sampai kita mendapatkan cukup pool link
        // untuk mengisi 2 server utama + potensi penambalan.
        const optionsClicked = new Set(); // ID opsi yang sudah diklik
        let linksExtractedCount = 0;

        for (const priorityServerName of OUTPUT_SERVER_PRIORITY_ORDER) {
            // Jika sudah ada cukup link di pool untuk mencoba seleksi akhir, berhenti mengklik server baru
            if (linksExtractedCount >= MIN_LINKS_FOR_PATCHING_POOL && clickedServerNames.size >= TARGET_NUM_PRIMARY_SERVERS) {
                console.log(`[Scraper] Cukup link (${linksExtractedCount}) dari ${clickedServerNames.size} server prioritas telah diekstrak. Menghentikan klik.`);
                break;
            }

            // Dapatkan semua opsi untuk server prioritas saat ini yang belum diklik
            const optionsForThisServer = allOptionDetails.filter(
                opt => opt.baseServerName === priorityServerName && !optionsClicked.has(opt.id)
            );

            if (optionsForThisServer.length > 0) {
                console.log(`[Scraper] Mengklik opsi untuk server: "${priorityServerName}" (${optionsForThisServer.length} varian)...`);
                clickedServerNames.add(priorityServerName);

                for (const option of optionsForThisServer) {
                    try {
                        const currentOptionHandle = await page.$(`#${option.id}`);
                        if (!currentOptionHandle) {
                            console.warn(`[Scraper] Tombol "${option.serverText}" (ID: ${option.id}) tidak dapat ditemukan kembali. Melewati.`);
                            continue;
                        }

                        console.log(`[Scraper] Mengklik: "${option.serverText}"`);
                        await currentOptionHandle.click();
                        optionsClicked.add(option.id); // Tandai sudah diklik
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
                            // Hanya simpan satu link per server+kualitas jika ada duplikasi URL entah dari mana
                            if (!availableLinksMap.get(option.baseServerName).has(option.quality)) {
                                availableLinksMap.get(option.baseServerName).set(option.quality, {
                                    server: option.baseServerName,
                                    quality: option.quality,
                                    url: validIframeSrc,
                                    priority: option.priority
                                });
                                linksExtractedCount++;
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
            }
        }

        console.log(`[Scraper] Fase ekstraksi selesai. Total link di pool: ${linksExtractedCount}.`);


        // --- FASE 2: Seleksi & Penambalan Link Output ---
        const finalStreamLinksOutput = [];
        const selectedPrimaryServers = []; // Server yang akan jadi 2 server utama di output
        const occupiedQualities = new Map(); // Map<ServerName, Set<Quality>> untuk slot yang sudah terisi

        // 2.1: Pilih 2 server utama berprioritas tertinggi yang berhasil memberikan link
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

            // Aturan penambalan:
            // 1. Cari dari server berprioritas tertinggi di antara server yang *bukan* server target utama itu sendiri,
            //    DAN *bukan* salah satu dari 2 server utama lainnya (untuk memenuhi "kenapa tidak dari nakama")
            // 2. Jika tidak ada, baru cari dari server berprioritas tertinggi di antara 2 server utama lainnya.
            // 3. Jika masih tidak ada, cari dari server berprioritas tertinggi yang ada di pool (di luar 2 server utama).

            const otherAvailableServers = Array.from(availableLinksMap.keys())
                .filter(sName => sName !== targetPrimaryServer && !occupiedQualities.get(sName)?.has(missingQuality)); // Server yang belum mengisi kualitas ini

            // Prioritaskan server patch yang BUKAN bagian dari 2 server utama terpilih
            for (const patchServerName of OUTPUT_SERVER_PRIORITY_ORDER) {
                if (patchServerName === targetPrimaryServer) continue; // Jangan menambal dari diri sendiri

                const isOtherPrimaryServer = selectedPrimaryServers.includes(patchServerName);
                const hasMissingQuality = availableLinksMap.get(patchServerName)?.has(missingQuality);

                if (hasMissingQuality) {
                    // Coba cari dari server yang BUKAN primary server lain (membuat output 3 atau 4 server)
                    if (!isOtherPrimaryServer && !occupiedQualities.get(patchServerName)?.has(missingQuality)) {
                        patchLinkFound = availableLinksMap.get(patchServerName).get(missingQuality);
                        console.log(`[Scraper] Penambal dari server lain (bukan utama) untuk ${targetPrimaryServer} - ${missingQuality}: ${patchServerName}`);
                        break;
                    }
                    // Jika tidak ada server non-utama, dan ini adalah server utama lainnya, pertimbangkan sebagai fallback
                    // Tapi hanya jika server utama lainnya belum mengisi slot kualitas ini
                    if (isOtherPrimaryServer && !occupiedQualities.get(patchServerName)?.has(missingQuality) && !patchLinkFound) {
                        patchLinkFound = availableLinksMap.get(patchServerName).get(missingQuality);
                        console.log(`[Scraper] Penambal dari server utama lainnya (fallback) untuk ${targetPrimaryServer} - ${missingQuality}: ${patchServerName}`);
                        // Jangan break, mungkin ada server non-utama yang lebih prioritas di loop selanjutnya
                    }
                }
            }

            // Jika patchLinkFound masih null, berarti patchServerName dari prioritas rendah mungkin ada
            if (!patchLinkFound) {
                for (const patchServerName of OUTPUT_SERVER_PRIORITY_ORDER) {
                    if (patchServerName === targetPrimaryServer) continue;
                    const hasMissingQuality = availableLinksMap.get(patchServerName)?.has(missingQuality);
                    if (hasMissingQuality) {
                        patchLinkFound = availableLinksMap.get(patchServerName).get(missingQuality);
                        console.log(`[Scraper] Penambal terakhir (any available) untuk ${targetPrimaryServer} - ${missingQuality}: ${patchServerName}`);
                        break; // Ambil yang pertama ditemukan
                    }
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
                // Jika tidak ada link penambal, slot ini akan kosong.
            }
        }

        // --- Finalisasi: Urutkan output untuk konsistensi ---
        finalStreamLinksOutput.sort((a, b) => {
            // Urutkan berdasarkan prioritas server
            const serverPriorityA = SERVER_PRIORITY[a.server] || SERVER_PRIORITY['Unknown'];
            const serverPriorityB = SERVER_PRIORITY[b.server] || SERVER_PRIORITY['Unknown'];
            if (serverPriorityA !== serverPriorityB) {
                return serverPriorityA - serverPriorityB;
            }
            // Lalu urutkan berdasarkan kualitas (1080p, 720p, 480p)
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