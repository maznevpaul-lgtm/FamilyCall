// --- 1. УТИЛИТА ЛОКАЛЬНОГО ХРАНИЛИЩА ---
const store = {
    get: (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set: (key, value) => { localStorage.setItem(key, JSON.stringify(value)); }
};

// --- 2. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И НАСТРОЙКИ WEBRTC ---
const rtcConfig = { 
    iceServers: [
        // Российские STUN серверы (Яндекс, SIPnet)
        { urls: "stun:stun.yandex.ru:3478" },
        { urls: "stun:stun.sipnet.ru:3478" },
        // Международные серверы (Google, Cloudflare)
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
        // TURN серверы для обхода NAT (Metered)
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }
    ] 
};

let sse, peerConnection, dataChannel, localStream, screenStream;
let myId, targetId, callMode = 'idle';
let currentCallMode = 'video';
let currentFacingMode = 'user'; 
let ringTimeout, chatHistory = [];
let isScreenSharing = false, isVideoSwapped = false;
const CHUNK_SIZE = 16384; 
let fileReceiveBuffer = [], incomingFileInfo = null;

let isCaller = false; 
let iceCandidateQueue = [];

// Фиксируем время запуска приложения, чтобы игнорировать старые WebRTC сигналы (допуск 10 сек)
const appStartTime = Date.now();

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let dialInterval = null, ringInterval = null;

const callUi = {
    status: document.getElementById('call-status'),
    localVideo: document.getElementById('local-video'),
    remoteVideo: document.getElementById('remote-video'),
    placeholder: document.getElementById('remote-placeholder'),
    chatBox: document.getElementById('chat-box'),
    msgInput: document.getElementById('msg-input'),
    sendBtn: document.getElementById('send-btn'),
    fileLabel: document.getElementById('file-label'),
    emojiBtn: document.getElementById('emoji-btn'),
    emojiPicker: document.getElementById('emoji-picker'),
    hangupBtn: document.getElementById('hangup-btn'),
    incomingOverlay: document.getElementById('incoming-overlay'),
    incomingCallerId: document.getElementById('incoming-caller-id'),
    fileInput: document.getElementById('file-input'),
    addUnknownBtn: document.getElementById('add-unknown-btn')
};

// --- ПОЛУЧИТЬ ИМЯ КОНТАКТА ПО ID ---
function getContactName(id) {
    if (!id) return "Неизвестный";
    const contacts = store.get('contacts') || [];
    const c = contacts.find(c => c.id === id);
    return c ? c.name : id;
}

// --- УНИВЕРСАЛЬНАЯ КАСТОМНАЯ МОДАЛКА УВЕДОМЛЕНИЙ ---
function showModal(text, title = "Уведомление", icon = "ℹ️", isConfirm = false, onOk = null) {
    document.getElementById('custom-alert-title').innerText = title;
    document.getElementById('custom-alert-text').innerHTML = text; // Разрешаем HTML теги типа <br>
    document.getElementById('custom-alert-icon').innerText = icon;
    document.getElementById('custom-alert-modal').style.display = 'flex';
    
    const okBtn = document.getElementById('custom-alert-ok');
    const cancelBtn = document.getElementById('custom-alert-cancel');
    
    cancelBtn.style.display = isConfirm ? 'block' : 'none';
    
    okBtn.onclick = () => {
        document.getElementById('custom-alert-modal').style.display = 'none';
        if (onOk) onOk();
    };
    
    cancelBtn.onclick = () => {
        document.getElementById('custom-alert-modal').style.display = 'none';
    };
}

// --- 3. ИНИЦИАЛИЗАЦИЯ И ВКЛАДКИ ---
function switchTab(tabId) {
    document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId + '-view').classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    
    // Очищаем красную точку с кнопки чата при переходе
    if (tabId === 'call') {
        document.getElementById('btn-call').innerText = "🖥️ Вызов";
        // Скроллим чат вниз если перешли
        if(callMode !== 'idle') callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
    }
}

myId = store.get('myId');
if (!myId) {
    myId = Math.random().toString(36).substring(2, 8).toUpperCase();
    store.set('myId', myId);
    store.set('contacts', []);
}
document.getElementById('my-id-display').innerText = myId;

// --- ФУНКЦИЯ ПРОВЕРКИ И СОХРАНЕНИЯ НЕИЗВЕСТНОГО КОНТАКТА ---
function checkUnknownContact(id) {
    const contacts = store.get('contacts') || [];
    const isKnown = contacts.some(c => c.id === id);
    if (!isKnown && id && id !== myId) {
        callUi.addUnknownBtn.style.display = 'inline-block';
        callUi.addUnknownBtn.onclick = () => {
            // Вместо системного prompt открываем нашу красивую модалку
            document.getElementById('add-unknown-id').value = id;
            document.getElementById('add-unknown-name').value = "Новый контакт";
            document.getElementById('add-unknown-modal').style.display = 'flex';
            document.getElementById('add-unknown-name').select(); // Выделяем текст для быстрого стирания
        };
    } else {
        callUi.addUnknownBtn.style.display = 'none';
    }
}

// Обработчики кнопок для новой модалки сохранения неизвестного контакта
document.getElementById('cancel-unknown-btn').addEventListener('click', () => {
    document.getElementById('add-unknown-modal').style.display = 'none';
});

document.getElementById('save-unknown-btn').addEventListener('click', () => {
    const name = document.getElementById('add-unknown-name').value.trim();
    const id = document.getElementById('add-unknown-id').value;
    
    if (!name) return; // Игнорируем пустое имя
    
    const contacts = store.get('contacts') || [];
    contacts.push({ name: name, id: id });
    store.set('contacts', contacts);
    renderContacts(contacts);
    
    callUi.addUnknownBtn.style.display = 'none';
    document.getElementById('call-peer-name').innerText = name;
    logSys(`Контакт ${name} успешно сохранен.`);
    
    document.getElementById('add-unknown-modal').style.display = 'none';
});


// --- 4. АУДИО СИНТЕЗАТОР ---
function playRingtone() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const doubleRing = () => {
        const playRingPip = (t) => {
            const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
            osc.frequency.value = 480; osc.connect(gain); gain.connect(audioCtx.destination);
            gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.3, t + 0.05); 
            gain.gain.setValueAtTime(0.3, t + 0.35); gain.gain.linearRampToValueAtTime(0, t + 0.4);
            osc.start(t); osc.stop(t + 0.4);
        };
        const now = audioCtx.currentTime;
        playRingPip(now); playRingPip(now + 0.6);
    };
    doubleRing();
    ringInterval = setInterval(doubleRing, 3000);
}
function stopRingtone() { if (ringInterval) clearInterval(ringInterval); ringInterval = null; }

function playMessageSound() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.frequency.setValueAtTime(800, audioCtx.currentTime); osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
    osc.connect(gain); gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0, audioCtx.currentTime); gain.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.02); gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.2);
    osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.2);
}

function playDialTone() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const beep = () => {
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.frequency.value = 425; osc.connect(gain); gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0, audioCtx.currentTime); gain.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.05);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime + 0.95); gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 1.0);
        osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 1.0);
    };
    beep(); dialInterval = setInterval(beep, 4000); 
}
function stopDialTone() { if (dialInterval) clearInterval(dialInterval); dialInterval = null; }

function playSuccessTone() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime, osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(400, now); osc.frequency.exponentialRampToValueAtTime(800, now + 0.3); 
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.2, now + 0.1); gain.gain.linearRampToValueAtTime(0, now + 0.4);
    osc.start(now); osc.stop(now + 0.4);
}

function playHangupTone() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const playPip = (t) => {
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.frequency.value = 300; osc.connect(gain); gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.2, t + 0.05); gain.gain.setValueAtTime(0.2, t + 0.25); gain.gain.linearRampToValueAtTime(0, t + 0.3);
        osc.start(t); osc.stop(t + 0.3);
    };
    const now = audioCtx.currentTime;
    playPip(now); playPip(now + 0.4); playPip(now + 0.8);
}

// НОВЫЕ ТИХИЕ ЛОГИ ПОВЕРХ ЭКРАНА
function logSys(text) {
    const container = document.getElementById('sys-logs');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'sys-log-item';
    div.innerText = "⚙️ " + text;
    container.appendChild(div);
    setTimeout(() => div.remove(), 4000);
}

// --- 5. ЛОГИКА АДРЕСНОЙ КНИГИ И НАСТРОЕК ---
function renderContacts(contacts) {
    const list = document.getElementById('contacts-list');
    list.innerHTML = ''; 
    if (contacts.length === 0) {
        list.innerHTML = '<li style="justify-content:center; color:#888; font-size:13px; background:transparent; border:none; box-shadow:none; cursor:default;">Список пуст</li>';
        return;
    }
    contacts.forEach((c, index) => {
        const li = document.createElement('li');
        li.innerHTML = `
            <div class="contact-content">
                <div class="contact-info" title="${c.name}">
                    <span class="contact-name">${c.name}</span>
                    <span class="contact-id">ID: ${c.id}</span>
                </div>
                <div class="contact-actions">
                    <button class="call-action-btn btn-call-video" data-id="${c.id}" data-mode="video" title="Видеозвонок">📹</button>
                    <button class="call-action-btn btn-call-audio" data-id="${c.id}" data-mode="audio" title="Голосовой звонок">📞</button>
                    <button class="call-action-btn btn-call-chat" data-id="${c.id}" data-mode="chat" title="Только чат">💬</button>
                </div>
            </div>
            <div class="del-handle" title="Опции">⋮</div>
            <div class="swipe-actions">
                <button class="btn-edit" data-index="${index}" title="Редактировать">✏️</button>
                <button class="btn-del" data-index="${index}" title="Удалить">✕</button>
            </div>
        `;

        const handle = li.querySelector('.del-handle');
        handle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = li.classList.contains('show-actions');
            document.querySelectorAll('#contacts-list li').forEach(el => el.classList.remove('show-actions'));
            if (!isOpen) li.classList.add('show-actions');
        });

        let touchStartX = 0;
        li.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
        li.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].clientX;
            const diffX = touchStartX - touchEndX;
            if (diffX > 40) { 
                document.querySelectorAll('#contacts-list li').forEach(el => el.classList.remove('show-actions'));
                li.classList.add('show-actions');
            } else if (diffX < -40) { 
                li.classList.remove('show-actions');
            }
        }, { passive: true });

        li.querySelector('.contact-content').addEventListener('click', () => li.classList.remove('show-actions'));
        list.appendChild(li);
    });

    document.querySelectorAll('.btn-call-video, .btn-call-audio, .btn-call-chat').forEach(btn => btn.addEventListener('click', (e) => {
        makeCall(e.currentTarget.getAttribute('data-id'), e.currentTarget.getAttribute('data-mode'));
    }));
    
    document.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', (e) => {
        const index = e.currentTarget.getAttribute('data-index');
        const contacts = store.get('contacts') || [];
        const contact = contacts[index];
        if (contact) {
            document.getElementById('edit-contact-index').value = index;
            document.getElementById('edit-contact-name').value = contact.name;
            document.getElementById('edit-contact-id').value = contact.id;
            document.getElementById('edit-contact-modal').style.display = 'flex';
        }
    }));

    document.querySelectorAll('.btn-del').forEach(btn => btn.addEventListener('click', (e) => {
        showModal(`Вы действительно хотите удалить этот контакт?`, "Удаление", "🗑️", true, () => {
            const contacts = store.get('contacts') || [];
            contacts.splice(e.currentTarget.getAttribute('data-index'), 1);
            store.set('contacts', contacts); renderContacts(contacts);
        });
    }));
}

renderContacts(store.get('contacts') || []);

document.getElementById('add-btn').addEventListener('click', () => {
    const name = document.getElementById('contact-name').value.trim();
    const id = document.getElementById('contact-id').value.trim().toUpperCase();
    if (!name || !id) return showModal("Пожалуйста, заполните поля Имя и ID.", "Ошибка", "⚠️");
    const contacts = store.get('contacts') || [];
    contacts.push({ name, id });
    store.set('contacts', contacts); renderContacts(contacts);
    document.getElementById('contact-name').value = ''; document.getElementById('contact-id').value = '';
});

document.getElementById('edit-id-btn').addEventListener('click', () => {
    document.getElementById('id-display-container').style.display = 'none';
    document.getElementById('id-edit-container').style.display = 'flex';
    document.getElementById('new-id-input').value = myId;
});

document.getElementById('cancel-id-btn').addEventListener('click', () => {
    document.getElementById('id-edit-container').style.display = 'none';
    document.getElementById('id-display-container').style.display = 'flex';
});

document.getElementById('save-id-btn').addEventListener('click', () => {
    const newId = document.getElementById('new-id-input').value.trim().toUpperCase().replace(/[^A-Z0-9А-Я]/g, ''); 
    if (!newId) return showModal("Ваш ID не может быть пустым!", "Ошибка", "⚠️");
    store.set('myId', newId); myId = newId;
    document.getElementById('my-id-display').innerText = newId;
    document.getElementById('id-edit-container').style.display = 'none';
    document.getElementById('id-display-container').style.display = 'flex';
    connectSignaling(); 
});

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
    document.getElementById('edit-contact-modal').style.display = 'none';
});

document.getElementById('save-edit-btn').addEventListener('click', () => {
    const index = document.getElementById('edit-contact-index').value;
    const name = document.getElementById('edit-contact-name').value.trim();
    const id = document.getElementById('edit-contact-id').value.trim().toUpperCase();
    
    if (!name || !id) return showModal("Пожалуйста, заполните поля Имя и ID.", "Ошибка", "⚠️");
    
    const contacts = store.get('contacts') || [];
    if (contacts[index]) {
        contacts[index].name = name;
        contacts[index].id = id;
        store.set('contacts', contacts); 
        renderContacts(contacts);
        document.getElementById('edit-contact-modal').style.display = 'none';
    }
});

let testStream, analyzer, micInterval;

async function requestMediaPermissions() {
    document.getElementById('cam-error-msg').style.display = 'none';
    try {
        testStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode }, audio: true });
        document.getElementById('test-video').srcObject = testStream;
        document.getElementById('test-video').style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
        document.getElementById('settings-switch-cam').style.display = 'block';
        
        const source = audioCtx.createMediaStreamSource(testStream);
        analyzer = audioCtx.createAnalyser(); analyzer.fftSize = 256; source.connect(analyzer);
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        if (micInterval) clearInterval(micInterval);
        micInterval = setInterval(() => {
            analyzer.getByteFrequencyData(dataArray);
            let sum = 0; for(let i=0; i < dataArray.length; i++) sum += dataArray[i];
            let level = Math.min(100, ((sum / dataArray.length) / 80) * 100); 
            document.getElementById('mic-level').style.width = level + '%';
            document.getElementById('mic-level').style.background = level > 85 ? '#f44336' : (level > 50 ? '#ff9800' : '#4caf50');
        }, 50);
        document.getElementById('req-perm-btn').innerText = "✅ Разрешения получены";
        document.getElementById('req-perm-btn').style.background = "#4caf50";
    } catch (e) { 
        document.getElementById('cam-error-msg').style.display = 'block';
        document.getElementById('cam-error-msg').innerHTML = "🚫 Доступ запрещен!<br><br>Нажмите на <b>иконку замка 🔒</b> в адресной строке браузера, выберите «Настройки сайтов» и разрешите Камеру и Микрофон, затем обновите страницу.";
    }
}

document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'flex';
    document.getElementById('req-perm-btn').innerText = "🎥 Запросить разрешения";
    document.getElementById('req-perm-btn').style.background = "#1976d2";
    requestMediaPermissions();
});

document.getElementById('req-perm-btn').addEventListener('click', requestMediaPermissions);

document.getElementById('close-settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
    if (testStream) testStream.getTracks().forEach(t => t.stop());
    if (micInterval) clearInterval(micInterval); testStream = null;
});

document.getElementById('export-btn').addEventListener('click', () => {
    const contacts = store.get('contacts') || [];
    if (contacts.length === 0) return showModal("Список контактов пуст! Экспортировать нечего.", "Экспорт", "📁");
    const blob = new Blob([JSON.stringify(contacts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'p2p_contacts.json'; a.click(); URL.revokeObjectURL(url);
});

document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const imported = JSON.parse(event.target.result);
            if (Array.isArray(imported)) { store.set('contacts', imported); renderContacts(imported); showModal("Ваши контакты были успешно восстановлены из файла.", "Импорт завершен", "✅"); }
        } catch (err) { showModal("Произошла ошибка при чтении файла резервной копии.", "Ошибка файла", "❌"); } e.target.value = ''; 
    }; reader.readAsText(file);
});

// --- 6. ЛОГИКА ВЫЗОВОВ И СИГНАЛЬНЫЙ СЕРВЕР ---
function sendSignal(target, data) {
    data.timestamp = Date.now(); // Добавляем метку времени для отсеивания старых пакетов
    fetch(`https://ntfy.sh/p2p_call_${target}`, { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
}

function resetCallUI() {
    stopDialTone(); stopRingtone();
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    callUi.localVideo.srcObject = null; callUi.remoteVideo.srcObject = null;
    
    document.querySelector('.video-panel').style.display = 'flex';
    callUi.placeholder.style.display = 'flex'; 
    callUi.status.innerText = 'Ожидание действий...';
    callUi.status.style.color = '#89b4fa';
    document.getElementById('call-peer-name').innerText = "Семейная связь";
    
    callUi.msgInput.disabled = true; callUi.sendBtn.disabled = true;
    callUi.msgInput.style.height = '40px';
    callUi.msgInput.style.overflowY = 'hidden';
    callUi.fileLabel.style.opacity = '0.5'; callUi.fileLabel.style.pointerEvents = 'none';
    callUi.emojiBtn.style.opacity = '0.5'; callUi.emojiBtn.style.pointerEvents = 'none';
    callUi.emojiPicker.style.display = 'none';
    
    document.getElementById('toggle-mic').style.opacity = '1';
    document.getElementById('toggle-mic').style.textDecoration = 'none';
    document.getElementById('toggle-cam').style.opacity = '1';
    document.getElementById('toggle-cam').style.textDecoration = 'none';
    
    if (callUi.addUnknownBtn) callUi.addUnknownBtn.style.display = 'none';

    isVideoSwapped = false;
    isCaller = false;
    iceCandidateQueue = [];
    
    callUi.localVideo.style = ''; callUi.remoteVideo.style = '';
    
    callMode = 'idle';
    wakeUpControls();
}

function loadChatHistory(id) {
    callUi.chatBox.innerHTML = '';
    chatHistory = store.get(`chat_${id}`) || [];
    chatHistory.forEach(msg => appendMsg(msg.text, msg.isMine, msg.isHtml, false, null, msg.id));
}

async function forceNegotiation() {
    if (!peerConnection) return;
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendSignal(targetId, { type: 'offer', targetId, offer, from: myId });
    } catch (err) {
        console.error("Ошибка при запросе соединения:", err);
    }
}

async function getAndAddMedia(kind) {
    try {
        let stream;
        if (kind === 'video') {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
            const videoTrack = stream.getVideoTracks()[0];
            if (!localStream) localStream = new MediaStream();
            localStream.addTrack(videoTrack);
            
            callUi.localVideo.srcObject = localStream;
            callUi.localVideo.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
            
            document.querySelector('.video-panel').style.display = 'flex';
            callUi.localVideo.style.display = 'block';
            callUi.remoteVideo.style.display = 'block';
            callUi.placeholder.style.display = 'none';
            
            if (peerConnection) {
                peerConnection.addTrack(videoTrack, localStream); 
                forceNegotiation();
            }
            logSys("Камера включена.");
        } else if (kind === 'audio') {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const audioTrack = stream.getAudioTracks()[0];
            if (!localStream) localStream = new MediaStream();
            localStream.addTrack(audioTrack);
            
            if (peerConnection) {
                peerConnection.addTrack(audioTrack, localStream);
                forceNegotiation();
            }
            logSys("Микрофон включен.");
        }
    } catch (e) {
        console.error(e);
        showModal("Не удалось получить доступ к " + (kind === 'audio' ? 'микрофону' : 'камере') + ".<br><br>Пожалуйста, проверьте системные разрешения вашего устройства.", "Ошибка доступа", "🚫");
    }
}

async function initMedia(mode) {
    const videoPanel = document.querySelector('.video-panel');

    if (mode === 'chat' || mode === 'audio') {
        videoPanel.style.display = 'none';
        document.getElementById('toggle-cam').style.opacity = '0.5';
        document.getElementById('toggle-cam').style.textDecoration = 'line-through';
        document.getElementById('toggle-mic').style.opacity = mode === 'chat' ? '0.5' : '1';
        document.getElementById('toggle-mic').style.textDecoration = mode === 'chat' ? 'line-through' : 'none';
        
        if (mode === 'chat') {
            logSys("Режим чата. Нажмите иконку камеры или микрофона внизу, чтобы добавить их в любой момент.");
            return;
        }
    } else {
        videoPanel.style.display = 'flex';
        callUi.localVideo.style.display = 'block';
        callUi.remoteVideo.style.display = 'block';
        document.getElementById('toggle-cam').style.opacity = '1';
        document.getElementById('toggle-cam').style.textDecoration = 'none';
        document.getElementById('toggle-mic').style.opacity = '1';
        document.getElementById('toggle-mic').style.textDecoration = 'none';
        callUi.placeholder.innerText = 'Ожидание подключения...';
    }

    try {
        const constraints = {
            audio: true,
            video: mode === 'video' ? { facingMode: currentFacingMode } : false
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (mode === 'video') {
            callUi.localVideo.srcObject = localStream; 
            callUi.localVideo.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
        }
        logSys(`Устройства активны (${mode})`);
    } catch (e) { 
        logSys("Доступ к медиа не выдан."); 
        videoPanel.style.display = 'none';
        document.getElementById('toggle-cam').style.opacity = '0.5';
        document.getElementById('toggle-cam').style.textDecoration = 'line-through';
        document.getElementById('toggle-mic').style.opacity = '0.5';
        document.getElementById('toggle-mic').style.textDecoration = 'line-through';
    }
}

// Новая логика для старта чата (можно писать сразу)
function startChat(targetIdStr) {
    targetId = targetIdStr.toUpperCase();
    currentCallMode = 'chat';
    callMode = 'call';
    isCaller = true;
    iceCandidateQueue = [];
    switchTab('call');
    
    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    checkUnknownContact(targetId);
    
    callUi.status.innerText = `Подключение...`;
    callUi.status.style.color = '#89b4fa';
    
    // Включаем поле ввода СРАЗУ, не дожидаясь WebRTC (Оффлайн-режим)
    callUi.msgInput.disabled = false;
    callUi.sendBtn.disabled = false;
    callUi.msgInput.placeholder = "Напишите сообщение...";
    callUi.emojiBtn.style.opacity = '1';
    callUi.emojiBtn.style.pointerEvents = 'auto';
    
    loadChatHistory(targetId);
    initMedia('chat');
    
    // Пытаемся установить P2P-туннель в фоне
    setupPeerConnection();
    dataChannel = peerConnection.createDataChannel('chatAndFiles');
    setupDataChannel();
    
    peerConnection.createOffer().then(offer => {
        peerConnection.setLocalDescription(offer);
        sendSignal(targetId, { type: 'chat_offer', targetId, offer, from: myId });
    }).catch(e => console.error(e));

    // Если WebRTC не собралось, меняем статус на оффлайн
    setTimeout(() => {
        if (callMode === 'call' && currentCallMode === 'chat' && (!peerConnection || peerConnection.connectionState !== 'connected')) {
            callUi.status.innerText = "Чат (Оффлайн / Сервер)";
            callUi.status.style.color = "#a6adc8";
        }
    }, 8000);

    wakeUpControls();
}

function makeCall(targetIdStr, mode) {
    if (mode === 'chat') {
        startChat(targetIdStr);
        return;
    }

    targetId = targetIdStr.toUpperCase();
    currentCallMode = mode;
    callMode = 'call'; switchTab('call');
    isCaller = true; 
    iceCandidateQueue = [];
    
    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    checkUnknownContact(targetId);
    
    callUi.status.innerText = `Звоним...`;
    
    loadChatHistory(targetId);
    
    initMedia(mode).then(() => {
        sendSignal(targetId, { type: 'ring', targetId, from: myId, callType: mode });
        playDialTone(); 
        ringTimeout = setTimeout(() => {
            if (!peerConnection || peerConnection.connectionState !== 'connected') {
                stopDialTone(); playHangupTone(); 
                callUi.status.innerText = "Нет ответа"; callUi.status.style.color = "#f38ba8";
                setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 3000);
            }
        }, 20000);
    });
    
    wakeUpControls();
}

async function processIceQueue() {
    while (iceCandidateQueue.length > 0) {
        let candidate = iceCandidateQueue.shift();
        try { 
            await peerConnection.addIceCandidate(candidate); 
        } catch(e) {
            console.error("Ошибка применения маршрута", e);
        }
    }
}

function connectSignaling() {
    if (!myId) return;
    if (sse) sse.close();
    // Подключаемся с параметром since=12h, чтобы получать оффлайн-сообщения, пока приложение было закрыто
    sse = new EventSource(`https://ntfy.sh/p2p_call_${myId}/sse?since=12h`);

    sse.onmessage = async (e) => {
        const payload = JSON.parse(e.data);
        if (payload.event !== 'message') return; 
        let msg; try { msg = JSON.parse(payload.message); } catch (err) { return; }
        if (msg.from === myId) return;

        // --- ОБРАБОТКА ОФФЛАЙН-СООБЩЕНИЙ (им разрешено быть старыми) ---
        if (msg.type === 'direct_msg') {
            let history = store.get(`chat_${msg.from}`) || [];
            const alreadyExists = history.some(m => m.id === msg.id);
            if (!alreadyExists) {
                checkUnknownContact(msg.from);
                history.push({ id: msg.id, text: msg.text, isMine: false, isHtml: false, timestamp: msg.timestamp });
                if (history.length > 100) history.shift();
                store.set(`chat_${msg.from}`, history);

                // Если мы сейчас находимся в чате с этим пользователем
                if (callMode !== 'idle' && targetId === msg.from) {
                    appendMsg(msg.text, false, false, false, null, msg.id);
                    playMessageSound();
                } else {
                    // Уведомляем пользователя о новом сообщении (красная точка)
                    if (!document.getElementById('call-view').classList.contains('active')) {
                        document.getElementById('btn-call').innerText = "🖥️ Вызов 🔴";
                    }
                    playMessageSound();
                    if (window.Notification && Notification.permission === 'granted' && document.hidden) {
                        const notif = new Notification(getContactName(msg.from), { body: msg.text });
                        notif.onclick = function() { window.focus(); this.close(); };
                    }
                }
            }
            return; 
        }

        // --- ФИЛЬТР КЭШИРОВАННЫХ ЗВОНКОВ И WebRTC ---
        // Игнорируем служебные пакеты, если:
        // 1. У них нет метки времени (слишком старые пакеты из кэша сервера)
        // 2. Они были отправлены ДО того, как мы открыли/обновили страницу (с допуском 10 сек)
        // 3. Они в принципе старше 15 секунд
        if (!msg.timestamp || msg.timestamp < appStartTime - 10000 || (Date.now() - msg.timestamp > 15000)) {
            return;
        }

        if (ringTimeout) clearTimeout(ringTimeout);

        // --- ОБРАБОТКА ТИХОГО ВХОДЯЩЕГО ЧАТА ---
        if (msg.type === 'chat_offer') {
            if (callMode !== 'idle') {
                sendSignal(msg.from, { type: 'reject', targetId: msg.from, from: myId, reason: 'busy' });
                return;
            }
            targetId = msg.from;
            callMode = 'answer';
            currentCallMode = 'chat';
            isCaller = false;
            iceCandidateQueue = [];
            
            document.getElementById('call-peer-name').innerText = getContactName(targetId);
            checkUnknownContact(targetId);

            loadChatHistory(targetId);
            initMedia('chat'); 
            
            callUi.msgInput.disabled = false;
            callUi.sendBtn.disabled = false;
            callUi.msgInput.placeholder = "Напишите сообщение...";
            callUi.emojiBtn.style.opacity = '1';
            callUi.emojiBtn.style.pointerEvents = 'auto';
            
            setupPeerConnection();
            
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                sendSignal(msg.from, { type: 'answer', targetId: msg.from, answer });
                processIceQueue();
            } catch(e) {
                console.error("Ошибка тихого чата", e);
            }
            return;
        }

        if (msg.type === 'ring' && callMode === 'idle') {
            targetId = msg.from; callMode = 'incoming';
            currentCallMode = msg.callType || 'video';
            isCaller = false;
            iceCandidateQueue = [];
            
            checkUnknownContact(targetId);
            
            let typeText = currentCallMode === 'video' ? '📹 Видеозвонок' : (currentCallMode === 'audio' ? '📞 Голосовой звонок' : '💬 Текстовый чат');
            if (window.Notification && Notification.permission === 'granted' && document.hidden) {
                const notif = new Notification("Входящий вызов!", { body: `Вам звонит: ${getContactName(targetId)} (${typeText})` });
                notif.onclick = function() { window.focus(); this.close(); };
            }

            document.getElementById('incoming-ring-ui').style.display = 'block';
            document.getElementById('incoming-canceled-ui').style.display = 'none';
            callUi.incomingCallerId.innerText = getContactName(targetId);
            document.getElementById('incoming-call-type').innerText = typeText;

            callUi.incomingOverlay.style.display = 'flex';
            playRingtone();
        } else if (msg.type === 'ring' && callMode !== 'idle') {
            sendSignal(msg.from, { type: 'reject', targetId: msg.from, from: myId, reason: 'busy' });
        }

        if (msg.type === 'cancel') {
            stopRingtone();
            if (callMode === 'incoming') {
                document.getElementById('incoming-ring-ui').style.display = 'none';
                document.getElementById('incoming-canceled-ui').style.display = 'block';
                setTimeout(() => { callUi.incomingOverlay.style.display = 'none'; resetCallUI(); }, 2500);
            } else if (callMode === 'call' || callMode === 'answer') {
                stopDialTone();
                playHangupTone();
                callUi.status.innerText = "Собеседник завершил вызов";
                callUi.status.style.color = "#f38ba8";
                setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 2000);
            }
        }

        if (msg.type === 'accept' && callMode === 'call') {
            stopDialTone(); callUi.status.innerText = "Ответ получен. Настройка...";
            setupPeerConnection(); 
            dataChannel = peerConnection.createDataChannel('chatAndFiles'); 
            setupDataChannel();
            forceNegotiation();
        }

        if (msg.type === 'reject' && callMode === 'call') {
            stopDialTone(); playHangupTone(); 
            if (msg.reason === 'busy') {
                callUi.status.innerText = "Абонент занят";
            } else {
                callUi.status.innerText = "Вызов отклонен";
            }
            callUi.status.style.color = "#f38ba8"; 
            setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 3000);
        }

        if (msg.type === 'offer') {
            if (!peerConnection) setupPeerConnection();
            
            if (peerConnection.signalingState !== "stable" && !isCaller) {
                return; 
            }

            await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            sendSignal(msg.from, { type: 'answer', targetId: msg.from, answer });
            processIceQueue();
        }

        if (msg.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
            processIceQueue();
        }

        if (msg.type === 'candidate' && peerConnection) {
            try {
                if (!msg.candidate) return;
                const candidate = new RTCIceCandidate(msg.candidate);
                if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                    await peerConnection.addIceCandidate(candidate);
                } else {
                    iceCandidateQueue.push(candidate);
                }
            } catch(e) { console.error("Ошибка применения маршрута", e); }
        }
    };

    sse.onerror = () => { if (sse) sse.close(); setTimeout(connectSignaling, 5000); };
}

setInterval(() => {
    if (myId) fetch(`https://ntfy.sh/p2p_call_${myId}`, { method: 'POST', body: 'ping' }).catch(() => {});
    if (!sse || sse.readyState === EventSource.CLOSED) connectSignaling();
}, 30000);

document.getElementById('accept-call-btn').onclick = async () => {
    stopRingtone(); callUi.incomingOverlay.style.display = 'none'; callMode = 'answer'; switchTab('call');
    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    callUi.status.innerText = `Соединение...`;
    sendSignal(targetId, { type: 'accept', targetId, from: myId });
    loadChatHistory(targetId); await initMedia(currentCallMode); setupVideoSwap();
    wakeUpControls();
};

document.getElementById('reject-call-btn').onclick = () => {
    stopRingtone(); callUi.incomingOverlay.style.display = 'none';
    sendSignal(targetId, { type: 'reject', targetId, from: myId }); resetCallUI();
};

// --- 7. WEBRTC P2P ЛОГИКА ---
function setupPeerConnection() {
    if (peerConnection) peerConnection.close();
    peerConnection = new RTCPeerConnection(rtcConfig);
    iceCandidateQueue = [];

    if (localStream) localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = (e) => { 
        if (e.candidate) {
            sendSignal(targetId, { type: 'candidate', targetId, candidate: e.candidate }); 
        }
    };
    
    peerConnection.ontrack = (e) => { 
        if (!callUi.remoteVideo.srcObject || callUi.remoteVideo.srcObject.id !== e.streams[0].id) {
            callUi.remoteVideo.srcObject = e.streams[0];
        }
        if (e.track.kind === 'video') {
            document.querySelector('.video-panel').style.display = 'flex';
            callUi.remoteVideo.style.display = 'block';
            callUi.localVideo.style.display = 'block';
            callUi.placeholder.style.display = 'none'; 
        }
    };
    
    peerConnection.ondatachannel = (e) => { dataChannel = e.channel; setupDataChannel(); };
    
    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
            playHangupTone();
            callUi.status.innerText = "Связь прервана";
            callUi.status.style.color = "#f38ba8";
            callUi.placeholder.style.display = 'flex';
            setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 2000);
        }
    };
}

function setupDataChannel() {
    dataChannel.onopen = () => {
        playSuccessTone(); callUi.status.innerText = "✅ P2P соединение установлено"; callUi.status.style.color = "#a6e3a1"; 
        callUi.msgInput.disabled = false; callUi.sendBtn.disabled = false; 
        
        // Включаем кнопку загрузки файлов только после установки P2P соединения
        callUi.fileLabel.style.opacity = '0.8'; callUi.fileLabel.style.pointerEvents = 'auto';
    };
    
    dataChannel.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'text') { 
            playMessageSound(); 
            appendMsg(msg.text, false, false, true, null, msg.id); 
            
            if (document.getElementById('call-view').classList.contains('active') === false) {
                document.getElementById('btn-call').innerText = "🖥️ Вызов 🔴";
            }

            if (window.Notification && Notification.permission === 'granted' && document.hidden) {
                const notif = new Notification(getContactName(targetId), { body: msg.text });
                notif.onclick = function() { window.focus(); this.close(); };
            }
        } 
        else if (msg.type === 'file-start') {
            incomingFileInfo = msg; fileReceiveBuffer = [];
            document.getElementById('file-progress-container').style.display = 'block';
            document.getElementById('file-progress-text').innerText = `Прием: ${msg.name}...`;
            document.getElementById('file-progress-bar').style.width = '0%';
        } 
        else if (msg.type === 'file-chunk') {
            fileReceiveBuffer.push(msg.chunk);
            document.getElementById('file-progress-bar').style.width = `${(msg.index / incomingFileInfo.totalChunks) * 100}%`;
        } 
        else if (msg.type === 'file-end') {
            document.getElementById('file-progress-container').style.display = 'none';
            const linkHtml = `<a href="${fileReceiveBuffer.join('')}" download="${incomingFileInfo.name}" style="color:#a6e3a1; text-decoration:underline; font-weight:bold;">📁 Скачать: ${incomingFileInfo.name}</a>`;
            playMessageSound(); appendMsg(linkHtml, false, true, true, `[Получен файл: ${incomingFileInfo.name}]`);
            fileReceiveBuffer = []; incomingFileInfo = null;
        }
    };
}

callUi.fileInput.addEventListener('change', () => {
    const file = callUi.fileInput.files[0];
    if (!file) return;
    if (dataChannel?.readyState !== 'open') return showModal("Для передачи файлов необходимо дождаться установки P2P соединения.", "Ожидание", "⏳");
    if (file.size > 20 * 1024 * 1024) return showModal("Размер файла превышает допустимый лимит (20 МБ).", "Файл слишком большой", "📎");

    const reader = new FileReader();
    document.getElementById('file-progress-container').style.display = 'block';
    document.getElementById('file-progress-text').innerText = `Отправка: ${file.name}...`;

    reader.onload = async () => {
        const chunks = reader.result.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'g')) || [];
        dataChannel.send(JSON.stringify({ type: 'file-start', name: file.name, totalChunks: chunks.length }));
        for (let i = 0; i < chunks.length; i++) {
            dataChannel.send(JSON.stringify({ type: 'file-chunk', chunk: chunks[i], index: i }));
            document.getElementById('file-progress-bar').style.width = `${(i / chunks.length) * 100}%`;
            if (i % 20 === 0) await new Promise(r => setTimeout(r, 10)); 
        }
        dataChannel.send(JSON.stringify({ type: 'file-end' }));
        document.getElementById('file-progress-container').style.display = 'none';
        appendMsg(`<i>Файл <b>${file.name}</b> отправлен</i>`, true, true, true, `[Отправлен файл: ${file.name}]`);
        callUi.fileInput.value = ''; 
    };
    reader.readAsDataURL(file); 
});

async function switchCameraTrack(streamHolder, videoElement, isCall) {
    if (!streamHolder) return;
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    try {
        const oldVideoTrack = streamHolder.getVideoTracks()[0];
        if (oldVideoTrack) oldVideoTrack.stop();

        const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
        const newVideoTrack = newStream.getVideoTracks()[0];

        streamHolder.removeTrack(oldVideoTrack);
        streamHolder.addTrack(newVideoTrack);

        videoElement.srcObject = streamHolder;
        videoElement.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';

        if (isCall && peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(newVideoTrack);
        }
        logSys(`Камера переключена (${currentFacingMode})`);
    } catch (e) {
        logSys("Ошибка переключения камеры");
        currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    }
}

document.getElementById('settings-switch-cam').onclick = () => switchCameraTrack(testStream, document.getElementById('test-video'), false);
document.getElementById('switch-cam').onclick = () => switchCameraTrack(localStream, callUi.localVideo, true);

// Динамическое включение и выключение медиа прямо во время звонка
document.getElementById('toggle-mic').onclick = async function() {
    if (!localStream || localStream.getAudioTracks().length === 0) {
        await getAndAddMedia('audio');
        if (localStream && localStream.getAudioTracks().length > 0) {
            this.style.opacity = '1'; 
            this.style.textDecoration = 'none';
        }
        return;
    }
    const t = localStream.getAudioTracks()[0]; 
    t.enabled = !t.enabled;
    this.style.opacity = t.enabled ? '1' : '0.5'; 
    this.style.textDecoration = t.enabled ? 'none' : 'line-through';
};

document.getElementById('toggle-cam').onclick = async function() {
    if (!localStream || localStream.getVideoTracks().length === 0) {
        await getAndAddMedia('video');
        if (localStream && localStream.getVideoTracks().length > 0) {
            this.style.opacity = '1'; 
            this.style.textDecoration = 'none';
        }
        return;
    }
    const t = localStream.getVideoTracks()[0]; 
    t.enabled = !t.enabled;
    this.style.opacity = t.enabled ? '1' : '0.5'; 
    this.style.textDecoration = t.enabled ? 'none' : 'line-through';
};

document.getElementById('share-screen').onclick = async function() {
    if (!peerConnection) return;
    if (isScreenSharing) { 
        if (screenStream) screenStream.getTracks().forEach(t => t.stop());
        const s = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        const localVideoTrack = localStream ? localStream.getVideoTracks()[0] : null;
        
        if (s && localVideoTrack) { 
            s.replaceTrack(localVideoTrack); 
            callUi.localVideo.srcObject = localStream; 
            callUi.localVideo.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none'; 
        } else if (s) {
            peerConnection.removeTrack(s);
        }
        this.innerHTML = window.innerWidth <= 768 ? "" : "Экран"; 
        this.style.background = "#a6e3a1"; isScreenSharing = false; 
        return; 
    }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({video: true});
        const screenTrack = screenStream.getVideoTracks()[0];
        if (!localStream) localStream = new MediaStream();
        
        const s = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (s) {
            s.replaceTrack(screenTrack);
        } else {
            peerConnection.addTrack(screenTrack, localStream);
            forceNegotiation();
        }
        
        callUi.localVideo.srcObject = screenStream; 
        callUi.localVideo.style.transform = 'none'; 
        document.querySelector('.video-panel').style.display = 'flex';
        
        this.innerHTML = window.innerWidth <= 768 ? "Ост." : "Остановить";
        this.style.background = "#f38ba8"; isScreenSharing = true;
        screenTrack.onended = () => { if (isScreenSharing) document.getElementById('share-screen').onclick(); };
    } catch (e) { logSys("Отмена экрана"); }
};

callUi.hangupBtn.onclick = () => {
    if (callMode !== 'idle') {
        sendSignal(targetId, { type: 'cancel', targetId, from: myId });
    }
    playHangupTone();
    callUi.status.innerText = "Завершение...";
    setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 1000); 
};

function setupVideoSwap() {
    callUi.localVideo.style.cursor = 'pointer'; callUi.remoteVideo.style.cursor = 'pointer';
    const togglePipSwap = () => {
        isVideoSwapped = !isVideoSwapped;
        if (isVideoSwapped) {
            callUi.localVideo.style.position = 'absolute'; callUi.localVideo.style.inset = '0';
            callUi.localVideo.style.width = '100%'; callUi.localVideo.style.height = '100%';
            callUi.localVideo.style.zIndex = '5'; callUi.localVideo.style.borderRadius = '0'; callUi.localVideo.style.objectFit = 'contain';
            
            callUi.remoteVideo.style.position = 'absolute'; 
            callUi.remoteVideo.style.bottom = window.innerWidth <= 768 ? '60px' : '70px';
            callUi.remoteVideo.style.right = window.innerWidth <= 768 ? '10px' : '15px'; 
            callUi.remoteVideo.style.width = window.innerWidth <= 768 ? '80px' : '120px'; 
            callUi.remoteVideo.style.zIndex = '10'; callUi.remoteVideo.style.borderRadius = '8px'; callUi.remoteVideo.style.objectFit = 'cover';
            callUi.remoteVideo.style.border = '2px solid #444';
        } else {
            callUi.localVideo.style = ''; callUi.remoteVideo.style = '';
            callUi.localVideo.style.transform = isScreenSharing ? 'none' : 'scaleX(-1)';
        }
    };
    callUi.localVideo.onclick = togglePipSwap; callUi.remoteVideo.onclick = togglePipSwap;
}

function escapeHTML(str) { return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)); }

function appendMsg(text, isMine, isHtml = false, saveToHistory = true, rawTextForHistory = null, msgId = null) {
    const div = document.createElement('div');
    div.className = `msg ${isMine ? 'msg-mine' : 'msg-peer'}`; div.innerHTML = isHtml ? text : escapeHTML(text);
    callUi.chatBox.appendChild(div); callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
    if (saveToHistory) {
        chatHistory.push({ id: msgId || Date.now().toString(), text: rawTextForHistory || text, isMine, isHtml: false, timestamp: Date.now() });
        if (chatHistory.length > 100) chatHistory.shift(); 
        store.set(`chat_${targetId}`, chatHistory);
    }
}

// --- АДАПТИВНОЕ ПОЛЕ ВВОДА И ОТПРАВКА ---
callUi.msgInput.addEventListener('input', function() {
    this.style.height = '40px'; 
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    this.style.overflowY = this.scrollHeight > 120 ? 'auto' : 'hidden';
});

callUi.msgInput.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        callUi.sendBtn.click();
    }
});

callUi.sendBtn.onclick = () => {
    const text = callUi.msgInput.value.trim();
    if (!text) return;

    const msgId = Date.now().toString() + Math.random().toString(36).substring(2, 6);
    appendMsg(text, true, false, true, null, msgId); 
    
    callUi.msgInput.value = '';
    callUi.msgInput.style.height = '40px';
    callUi.msgInput.style.overflowY = 'hidden';

    if (dataChannel?.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'text', text: text, id: msgId }));
    } else {
        sendSignal(targetId, { type: 'direct_msg', text: text, id: msgId, from: myId });
    }
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('#contacts-list li')) {
        document.querySelectorAll('#contacts-list li').forEach(el => el.classList.remove('show-actions'));
    }
});

// --- ФИКС КЛАВИАТУРЫ ДЛЯ МОБИЛЬНЫХ (VISUAL VIEWPORT) ---
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        document.body.style.height = window.visualViewport.height + 'px';
        if (callMode !== 'idle') {
            callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
        }
    });
}

// --- 8. АВТОСКРЫТИЕ КНОПОК ПРИ НЕАКТИВНОСТИ ---
let controlsTimeout;
const callView = document.getElementById('call-view');
const controlsEl = document.querySelector('.controls');

function wakeUpControls() {
    if (!controlsEl) return;
    controlsEl.style.opacity = '1';
    controlsEl.style.pointerEvents = 'auto';
    controlsEl.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(controlsTimeout);
    
    if (callMode === 'call' || callMode === 'answer' || callMode === 'incoming') {
        controlsTimeout = setTimeout(() => {
            controlsEl.style.opacity = '0';
            controlsEl.style.pointerEvents = 'none';
            controlsEl.style.transform = 'translateX(-50%) translateY(20px)';
        }, 3000);
    }
}

callView.addEventListener('mousemove', wakeUpControls);
callView.addEventListener('touchstart', wakeUpControls, { passive: true });
callView.addEventListener('click', wakeUpControls);

controlsEl.addEventListener('mouseenter', () => clearTimeout(controlsTimeout));
controlsEl.addEventListener('mouseleave', wakeUpControls);

wakeUpControls();

// --- 9. ЗАПРОС РАЗРЕШЕНИЙ НА УВЕДОМЛЕНИЯ ---
document.body.addEventListener('click', () => {
    if (window.Notification && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}, { once: true });

connectSignaling();