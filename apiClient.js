// apiClient.js
require('dotenv').config();
const axios = require('axios');

let apiClient = null;
const BOT_ID = Math.random().toString(36).substring(2, 12);

function setBaseUrl(baseUrl) {
    if (!baseUrl) {
        console.error("Kesalahan: Base URL API Manager tidak disetel.");
        process.exit(1);
    }

    apiClient = axios.create({
        baseURL: baseUrl,
        headers: {
            'Content-Type': 'application/json',
            // Bisa tambahin auth token kalau perlu:
            // 'Authorization': `Bearer ${process.env.API_TOKEN}`
        }
    });

    console.log(`[API] Base URL di-set ke: ${baseUrl}`);
}

/**
 * Meminta paket pekerjaan dari Manajer.
 * @returns {Promise<Array|null>} Daftar anime untuk di-scrape atau null jika tidak ada pekerjaan.
 */
async function requestJob() {
    if (!apiClient) throw new Error("API Client belum diinisialisasi. Panggil setBaseUrl() dulu!");

    try {
        console.log(`[API] Meminta pekerjaan...`);
        const response = await apiClient.post('/jobs/request', { botId: BOT_ID });

        if (response.data && Array.isArray(response.data.jobs) && response.data.jobs.length > 0) {
            console.log(`[API] Berhasil menerima ${response.data.jobs.length} pekerjaan baru.`);
            return response.data.jobs;
        } else {
            console.log('[API] Tidak ada pekerjaan yang tersedia.');
            return null;
        }
    } catch (error) {
        console.error('[API] Gagal meminta pekerjaan:', error.message);
        if (error.response && error.response.data) {
            console.error('[API] Detail error dari Manajer:', error.response.data);
        }
        return null;
    }
}

/**
 * Mengirimkan hasil scraping episode kembali ke Manajer.
 * @param {number} mal_id - MAL ID anime.
 * @param {number} episode_number - Nomor episode yang di-scrape.
 * @param {Array<Object>} sources - Daftar link streaming yang ditemukan.
 * @returns {Promise<boolean>}
 */
async function submitResult(mal_id, episode_number, sources) {
    // BARU: Tambahkan validasi dasar untuk apiClient sebelum mencoba request
    if (!apiClient) {
        console.warn(`[API] Peringatan: API Client belum diinisialisasi. Hasil untuk MAL ID ${mal_id} Ep ${episode_number} tidak dapat dikirim ke backend.`);
        return false;
    }

    try {
        const payload = {
            botId: BOT_ID,
            mal_id,
            episode_number,
            sources
        };
        console.log(`[API] Mengirimkan hasil untuk MAL ID ${mal_id} Ep ${episode_number}.`);
        await apiClient.post('/jobs/submit', payload);
        console.log(`[API] Hasil untuk MAL ID ${mal_id} Ep ${episode_number} berhasil dikirim.`);
        return true;
    } catch (error) {
        console.error(`[API] Gagal mengirimkan hasil untuk MAL ID ${mal_id} Ep ${episode_number}:`, error.message);
        if (error.response && error.response.data) {
            console.error(`[API] Detail error saat submit untuk ${mal_id} Ep ${episode_number}:`, error.response.data);
        }
        return false;
    }
}

module.exports = {
    setBaseUrl,
    requestJob,
    submitResult
};