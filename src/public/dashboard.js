// dashboard.js
document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // Cache DOM Elements
    const elements = {
        tabManual: document.getElementById('tabManual'),
        tabAutomatic: document.getElementById('tabAutomatic'),
        manualModePanel: document.getElementById('manualMode'),
        automaticModePanel: document.getElementById('automaticMode'),
        apiUrlInput: document.getElementById('apiUrl'),
        saveApiUrlBtn: document.getElementById('saveApiUrl'),
        manualForm: document.getElementById('manualForm'),
        manualLinkInput: document.getElementById('manualLink'),
        manualMalIdInput: document.getElementById('manualMalId'),
        automaticForm: document.getElementById('automaticForm'),
        workerCountSelect: document.getElementById('workerCount'),
        startManualBtn: document.getElementById('startManualBot'),
        startAutomaticBtn: document.getElementById('startAutomaticBot'),
        stopAllBotsBtn: document.getElementById('stopAllBots'),
        botStatusContainer: document.getElementById('bot-status-container'),
        logModal: document.getElementById('logModal'),
        logContent: document.getElementById('logContent'),
        closeModalBtn: document.querySelector('.close-button'),
        notificationContainer: document.getElementById('notification-container')
    };

    const state = {
        botCount: 0
    };

    // --- UI Functions ---
    const switchTab = (isManual) => {
        elements.tabManual.classList.toggle('active', isManual);
        elements.tabAutomatic.classList.toggle('active', !isManual);
        elements.manualModePanel.classList.toggle('active', isManual);
        elements.automaticModePanel.classList.toggle('active', !isManual);
    };

    const updatePlaceholder = () => {
        const placeholder = elements.botStatusContainer.querySelector('.placeholder');
        if (state.botCount > 0 && placeholder) {
            placeholder.remove();
        } else if (state.botCount === 0 && !placeholder) {
            elements.botStatusContainer.innerHTML = '<p class="placeholder">Menunggu tugas bot...</p>';
        }
    };

    const toggleControls = (disabled) => {
        elements.startManualBtn.disabled = disabled;
        elements.startAutomaticBtn.disabled = disabled;
        elements.stopAllBotsBtn.disabled = !disabled;
    };

    const showNotification = (message, type = 'info') => {
        const notif = document.createElement('div');
        notif.className = `notification ${type}`;
        notif.textContent = message;
        elements.notificationContainer.appendChild(notif);
        setTimeout(() => notif.remove(), 3000);
    };

    // --- Bot Card Management ---
    const createOrUpdateBotCard = (data) => {
        let card = document.getElementById(`bot-${data.id}`);
        const isActive = data.progressLine && data.progressLine !== 'Idle';

        if (!card) {
            card = document.createElement('div');
            card.id = `bot-${data.id}`;
            card.className = 'bot-card';
            card.innerHTML = `
                <div class="bot-card-header">
                    <span class="bot-id">BOT-${data.id}</span>
                    <button class="log-button" data-botid="${data.id}">Log</button>
                </div>
                <div class="info title"><strong>Judul:</strong> <span>${data.animeTitle || 'Menunggu tugas...'}</span></div>
                <div class="info episode"><strong>Episode:</strong> <span>${data.episode || '-'}</span></div>
                <div class="info processed"><strong>Diproses:</strong> <span>${data.processedCount || 0}</span></div>
                <div class="info progress"><strong>Status:</strong> <span>${data.progressLine || 'Idle'}</span></div>
            `;
            elements.botStatusContainer.appendChild(card);
            state.botCount++;
            updatePlaceholder();
        } else {
            // More efficient update: only change text content
            card.querySelector('.title span').textContent = data.animeTitle || 'Menunggu tugas...';
            card.querySelector('.episode span').textContent = data.episode || '-';
            card.querySelector('.processed span').textContent = data.processedCount || 0;
            card.querySelector('.progress span').textContent = data.progressLine || 'Idle';
        }

        card.classList.toggle('is-active', isActive);
    };

    // --- Event Listeners ---
    elements.tabManual.addEventListener('click', () => switchTab(true));
    elements.tabAutomatic.addEventListener('click', () => switchTab(false));

    elements.saveApiUrlBtn.addEventListener('click', () => {
        const url = elements.apiUrlInput.value.trim();
        if (url) {
            socket.emit('set_api_url', url);
            showNotification(`URL API diatur ke: ${url}`);
        } else {
            showNotification('URL API tidak boleh kosong.', 'error');
        }
    });

    elements.manualForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const link = elements.manualLinkInput.value.trim();
        const malId = elements.manualMalIdInput.value.trim();
        if (!link || !malId) {
            showNotification('Link dan MAL ID wajib diisi.', 'error');
            return;
        }
        socket.emit('start_manual_bot', { link, malId });
        toggleControls(true);
        elements.manualLinkInput.value = '';
        elements.manualMalIdInput.value = '';
    });

    elements.automaticForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const workerCount = parseInt(elements.workerCountSelect.value, 10);
        socket.emit('start_automatic_bot', { workerCount });
        toggleControls(true);
    });

    elements.stopAllBotsBtn.addEventListener('click', () => {
        socket.emit('stop_all_bots');
        showNotification('Mengirim permintaan untuk menghentikan semua bot...');
    });

    elements.botStatusContainer.addEventListener('click', (event) => {
        if (event.target.classList.contains('log-button')) {
            const botId = event.target.dataset.botid;
            socket.emit('request_log', botId);
        }
    });

    elements.closeModalBtn.addEventListener('click', () => {
        elements.logModal.style.display = 'none';
    });

    window.addEventListener('click', (event) => {
        if (event.target == elements.logModal) {
            elements.logModal.style.display = 'none';
        }
    });

    // --- Socket.IO Listeners ---
    socket.on('connect', () => {
        console.log('Terhubung ke server!');
    });

    socket.on('bot_status_update', (data) => {
        createOrUpdateBotCard(data);
    });

    socket.on('bot_stopped', (botId) => {
        const card = document.getElementById(`bot-${botId}`);
        if (card) {
            card.remove();
            state.botCount--;
            updatePlaceholder();
        }
    });

    socket.on('all_bots_stopped', () => {
        toggleControls(false);
        elements.botStatusContainer.innerHTML = '<p class="placeholder">Semua bot telah dihentikan. Siap untuk tugas baru.</p>';
        state.botCount = 0;
        showNotification('Semua bot berhasil dihentikan.', 'info');
    });

    socket.on('log_data', (data) => {
        elements.logContent.textContent = data.log || 'Tidak ada log untuk ditampilkan.';
        elements.logModal.style.display = 'block';
    });

    socket.on('error_message', (message) => {
        showNotification(message, 'error');
    });
});