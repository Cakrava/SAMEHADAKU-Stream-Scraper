// test.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const readline = require('readline');

puppeteer.use(StealthPlugin());

/**
 * Fungsi pembantu untuk menjeda eksekusi.
 * @param {number} ms - Milidetik untuk tidur.
 */
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Map prioritas server (angka lebih kecil = prioritas lebih tinggi)
const SERVER_PRIORITY = {
    'Pucuk': 1,
    'Nakama': 2,
    'Mega': 3,
    'Premium': 4,
    'Blogspot': 5,
    'Unknown': 99 // Untuk server yang tidak terdaftar
};

// Urutan prioritas server untuk PEMILIHAN AKHIR server output
const OUTPUT_SERVER_PRIORITY_ORDER = ['Pucuk', 'Nakama', 'Mega', 'Premium', 'Blogspot'];
const TARGET_NUM_SERVERS_FOR_OUTPUT = 2; // Hanya ingin link dari 2 server prioritas teratas

/**
 * Fungsi uji untuk meng-scrape episode dan mengekstrak link video dengan prioritas.
 * @param {string} url - URL halaman episode yang akan diuji.
 */
async function runTestScrape(url) {
    let browser;
    let page;
    const allExtractedLinks = []; // Array untuk menyimpan semua link yang berhasil diekstrak
    const selectedOutputServers = new Set(); // Melacak nama server yang linknya sudah berhasil diambil (untuk output)
    // const processedServerNames = new Set(); // Ini tidak lagi diperlukan dengan perbaikan di bawah

    try {
        console.log('[Test Scraper] Meluncurkan browser...');
        browser = await puppeteer.launch({
            headless: true, // Set ke `false` untuk melihat browser beraksi
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-notifications',
                // '--disable-gpu',
                // '--no-zygote',
                // '--disable-accelerated-2d-canvas',
                // '--disable-dev-shm-usage',
                // '--single-process'
            ]
        });
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        console.log(`[Test Scraper] Mengunjungi URL: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const serverSelector = 'div.east_player_option';

        console.log(`[Test Scraper] Menunggu selector server: '${serverSelector}' selama 30 detik.`);
        try {
            await page.waitForSelector(serverSelector, { timeout: 30000 });
            console.log(`[Test Scraper] Selector server ditemukan.`);
        } catch (e) {
            console.error(`[Test Scraper] Gagal menemukan tombol server dengan selektor '${serverSelector}' di '${url}' dalam 30 detik. Aborting.`);
            return;
        }

        const initialServerOptionHandles = await page.$$(serverSelector);

        if (initialServerOptionHandles.length === 0) {
            console.warn(`[Test Scraper] Tidak ada opsi server yang ditemukan dengan selektor '${serverSelector}' di halaman ${url}.`);
            return;
        }

        console.log(`[Test Scraper] Ditemukan ${initialServerOptionHandles.length} opsi server di DOM.`);

        // Kumpulkan detail semua opsi server sebelum mulai mengklik
        const serverOptionsDetails = [];
        for (const handle of initialServerOptionHandles) {
            const { id, className, textContent } = await page.evaluate(el => ({
                id: el.id,
                className: el.className,
                textContent: el.textContent.trim()
            }), handle);
            const serverText = textContent;
            const serverMatch = serverText.match(/^(.+?)(?:\s*(\d{3,4}p))?$/i);
            const baseServerName = serverMatch && serverMatch[1] ? serverMatch[1].trim() : 'Unknown';

            serverOptionsDetails.push({
                // handle: handle, // Tidak menyimpan handle asli karena bisa stale, akan dicari ulang berdasarkan ID
                id: id,
                className: className,
                serverText: serverText,
                baseServerName: baseServerName,
                quality: serverMatch && serverMatch[2] ? serverMatch[2].trim() : 'Unknown',
                processed: false // Menandai apakah tombol ini sudah diklik/diproses
            });
        }

        console.log(`[Test Scraper] Memulai proses klik berdasarkan prioritas...`);

        // Iterasi melalui urutan prioritas server yang diinginkan untuk output
        for (const priorityServerName of OUTPUT_SERVER_PRIORITY_ORDER) {
            // Jika sudah mendapatkan link dari cukup banyak server untuk output, berhenti.
            if (selectedOutputServers.size >= TARGET_NUM_SERVERS_FOR_OUTPUT) {
                console.log(`[Status] Sudah mendapatkan link dari ${TARGET_NUM_SERVERS_FOR_OUTPUT} server prioritas. Menghentikan pencarian server lebih lanjut.`);
                break;
            }

            // Filter opsi server yang sesuai dengan server prioritas saat ini DAN belum diproses
            const optionsForCurrentPriorityServer = serverOptionsDetails.filter(
                detail => detail.baseServerName === priorityServerName && !detail.processed
            );

            if (optionsForCurrentPriorityServer.length > 0) {
                console.log(`[Processing] Memproses server: "${priorityServerName}". Ditemukan ${optionsForCurrentPriorityServer.length} opsi.`);
                let foundAnyLinkForThisServer = false;

                for (const option of optionsForCurrentPriorityServer) {
                    try {
                        // --- PERBAIKAN DI SINI: Mencari elemen berdasarkan ID langsung ---
                        // Menggunakan page.$() untuk mencari elemen berdasarkan ID uniknya.
                        // Ini lebih robust daripada mencoba menemukan kembali dari semua $$.
                        const currentOptionHandle = await page.$(`#${option.id}`);
                        // --- AKHIR PERBAIKAN ---

                        if (!currentOptionHandle) {
                            console.warn(`[Warning] Tombol "${option.serverText}" (ID: ${option.id}) tidak dapat ditemukan kembali di DOM. Melewati.`);
                            continue;
                        }

                        console.log(`[Click] <div> id:${option.id || 'unknown'} class:${option.className || 'unknown'} action:unknown (likely JS) text:${option.serverText}`);

                        await currentOptionHandle.click();
                        option.processed = true; // Tandai tombol ini sudah diklik
                        await sleep(5000);

                        const iframeSrcs = await page.evaluate(() => {
                            const iframes = Array.from(document.querySelectorAll('iframe'));
                            return iframes.map(iframe => iframe.src).filter(src => src);
                        });

                        const validIframeSrc = iframeSrcs.find(src =>
                            src &&
                            !src.includes('facebook.com') &&
                            !src.includes('fb.watch') &&
                            !src.includes('sso.ruangotaku.com') &&
                            !src.includes('dtscout.com') &&
                            !src.includes('crwdcntrl.net') &&
                            !src.includes('ads.google.com') &&
                            !src.includes('googlesyndication.com') &&
                            !src.includes('adserver') &&
                            !src.includes('popads') &&
                            !src.includes('popunder') &&
                            !src.includes('tracker') &&
                            !src.includes('analytics')
                        );

                        if (validIframeSrc) {
                            allExtractedLinks.push({
                                server: option.baseServerName,
                                quality: option.quality,
                                url: validIframeSrc,
                                priority: SERVER_PRIORITY[option.baseServerName] || SERVER_PRIORITY['Unknown']
                            });
                            foundAnyLinkForThisServer = true;
                            console.log(`[Raw Extracted] Server: "${option.baseServerName}", Kualitas: "${option.quality}", URL: "${validIframeSrc}"`);
                        } else {
                            console.log(`[Raw Extracted] Tidak ada link video valid ditemukan untuk opsi "${option.serverText}". Ditemukan iframe:`, iframeSrcs);
                        }

                    } catch (error) {
                        console.error(`[Test Scraper] Error saat memproses opsi server "${option.serverText}" (ID: ${option.id}):`, error.message);
                    }
                }

                // Jika server prioritas ini berhasil memberikan setidaknya satu link, masukkan ke daftar server output terpilih
                if (foundAnyLinkForThisServer) {
                    selectedOutputServers.add(priorityServerName);
                    console.log(`[Success] Server "${priorityServerName}" berhasil memberikan link. Total server terpilih: ${selectedOutputServers.size}`);
                }
            } else {
                console.log(`[Skipping] Server "${priorityServerName}" tidak memiliki opsi yang belum diproses di halaman.`);
            }
        }

        // --- Finalisasi Hasil (Filter hanya dari server yang terpilih) ---
        const finalStreamLinks = allExtractedLinks.filter(link =>
            selectedOutputServers.has(link.server)
        );

        console.log('\n--- Hasil Akhir Scraping (2 Server Prioritas Teratas dengan Link) ---');
        if (finalStreamLinks.length > 0) {
            finalStreamLinks.forEach(link => {
                console.log(`Server: ${link.server}, Kualitas: ${link.quality}, URL: ${link.url}`);
            });
        } else {
            console.log('Tidak ada link streaming yang berhasil diekstrak dari server prioritas yang memenuhi kriteria.');
        }

    } catch (error) {
        console.error('[Test Scraper] Kesalahan fatal saat menjalankan test scrape:', error);
    } finally {
        if (page) await page.close();
        if (browser) await browser.close();
        console.log('[Test Scraper] Browser ditutup.');
    }
}

// Fungsi utama untuk mengambil input dan menjalankan test
async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Masukkan URL episode untuk di-scrape (misal: https://v1.samehadaku.how/sakamoto-days-cour-2-episode-1/): ', async (inputUrl) => {
        if (!inputUrl) {
            console.error("URL tidak boleh kosong.");
            rl.close();
            return;
        }
        await runTestScrape(inputUrl.trim());
        rl.close();
    });
}

main();