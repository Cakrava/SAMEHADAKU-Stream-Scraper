// server.js (STATEFUL FIX)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { fork } = require('child_process');
const apiClient = require('./src/config/apiClient'); // <-- BARU: Impor apiClient

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'src', 'public')));

let activeBots = new Map();
let botLogs = new Map();
let apiManagerUrl = '';

// ============================================================================
// KUNCI PERBAIKAN: Map untuk menyimpan state UI dari setiap bot
// ============================================================================
let botUiState = new Map();

const linkQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue || linkQueue.length === 0) return;
    isProcessingQueue = true;
    const job = linkQueue.shift();
    console.log(`[Queue] Processing submit for: MAL ID ${job.mal_id} Ep ${job.episode_number}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    isProcessingQueue = false;
    processQueue();
}

io.on('connection', (socket) => {
    console.log('[Socket.IO] User connected');
    // Kirim state semua bot yang sedang berjalan ke user yang baru konek
    socket.emit('initial_bot_states', Array.from(botUiState.values()));

    socket.on('set_api_url', (url) => {
        console.log(`[Server] API URL has been set to: ${url}`);
        apiManagerUrl = url;
        apiClient.setBaseUrl(url);
        activeBots.forEach(botProcess => {
            botProcess.send({ type: 'SET_URL', url: apiManagerUrl });
        });
    });

    socket.on('start_manual_bot', ({ link, malId }) => {
        if (!apiManagerUrl) { /* ... (error handling tetap sama) ... */ return; }

        const botId = `manual-${Date.now()}`;

        // 1. Buat state awal dan simpan
        const initialState = {
            id: botId,
            animeTitle: `Manual Job for MAL ID ${malId}`,
            episode: '-',
            processedCount: 0,
            progressLine: 'Initializing...'
        };
        botUiState.set(botId, initialState);

        // 2. Kirim state awal ke SEMUA klien
        io.emit('bot_status_update', initialState);

        const botProcess = fork(path.join(__dirname, 'src', 'services', 'bot_worker.js'));
        activeBots.set(botId, botProcess);
        botLogs.set(botId, `[${new Date().toISOString()}] Bot manual started.\n`);

        botProcess.send({ type: 'INIT', payload: { apiUrl: apiManagerUrl, botId } });
        botProcess.send({ type: 'START_MANUAL', payload: { link, malId } });

        botProcess.on('message', (msg) => handleBotMessage(msg, botId));
        botProcess.on('exit', (code) => handleBotExit(botId, code));
    });

    socket.on('start_automatic_bot', ({ workerCount }) => {
        if (!apiManagerUrl) { /* ... (error handling tetap sama) ... */ return; }

        for (let i = 1; i <= workerCount; i++) {
            setTimeout(() => {
                const botId = `auto-${i}`;
                if (activeBots.has(botId)) return;

                const initialState = {
                    id: botId,
                    animeTitle: 'Waiting for job...',
                    episode: '-',
                    processedCount: 0,
                    progressLine: 'Initializing...'
                };
                botUiState.set(botId, initialState);
                io.emit('bot_status_update', initialState);

                const botProcess = fork(path.join(__dirname, 'src', 'services', 'bot_worker.js'));
                activeBots.set(botId, botProcess);
                botLogs.set(botId, `[${new Date().toISOString()}] Bot otomatis ${i} started.\n`);

                botProcess.send({ type: 'INIT', payload: { apiUrl: apiManagerUrl, botId } });
                botProcess.send({ type: 'START_AUTO' });

                botProcess.on('message', (msg) => handleBotMessage(msg, botId));
                botProcess.on('exit', (code) => handleBotExit(botId, code));
            }, i * 1500);
        }
    });

    socket.on('stop_all_bots', () => {
        activeBots.forEach((botProcess) => botProcess.kill('SIGTERM'));
        activeBots.clear();
        botLogs.clear();
        botUiState.clear(); // Hapus semua state
        io.emit('all_bots_stopped');
    });

    // ... (sisa event handler seperti 'request_log' tetap sama) ...
});

// ============================================================================
// KUNCI PERBAIKAN: Fungsi ini sekarang stateful
// ============================================================================
function handleBotMessage(msg, botId) {
    if (msg.type === 'STATUS_UPDATE') {
        // 1. Dapatkan state terakhir dari bot ini
        const currentState = botUiState.get(botId) || { id: botId };

        // 2. Gabungkan state lama dengan update baru dari worker
        const newState = { ...currentState, ...msg.payload };

        // 3. Simpan state yang sudah digabung
        botUiState.set(botId, newState);

        // 4. Kirim state LENGKAP ke semua klien
        io.emit('bot_status_update', newState);

        // Logging (tetap)
        const logMessage = `[${new Date().toISOString()}] [${botId}] ${msg.payload.progressLine || 'Status update'}\n`;
        const currentLog = botLogs.get(botId) || '';
        botLogs.set(botId, currentLog + logMessage);

    } else if (msg.type === 'QUEUE_SUBMIT') {
        // ... (fungsi ini tidak berubah) ...
    }
}

function handleBotExit(botId, exitCode) {
    console.log(`Bot ${botId} has exited with code ${exitCode}.`);

    // Kirim status akhir sebelum menghapus
    const finalState = botUiState.get(botId) || { id: botId };
    finalState.progressLine = `Exited (code ${exitCode}).`;
    io.emit('bot_status_update', finalState);

    // Hapus setelah jeda agar user bisa melihat status akhir
    setTimeout(() => {
        io.emit('bot_stopped', botId);
        botUiState.delete(botId);
    }, 5000);

    activeBots.delete(botId);
}

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});