// --- 1. УТИЛИТА ЛОКАЛЬНОГО ХРАНИЛИЩА ---
const store = {
    get: (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set: (key, value) => { localStorage.setItem(key, JSON.stringify(value)); }
};

// --- 2. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И НАСТРОЙКИ WEBRTC ---
const rtcConfig = { 
    iceServers: [
        { urls: "stun:stun.yandex.ru:3478" },
        { urls: "stun:stun.sipnet.ru:3478" },
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
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
let currentSessionId = null; 

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

function getContactName(id) {
    if (!id) return "Неизвестный";
    const contacts = store.get('contacts') || [];
    const c = contacts.find(c => c.id === id);
    return c ? c.name : id;
}

function showModal(text, title = "Уведомление", icon = "ℹ️", isConfirm = false, onOk = null) {
    document.getElementById('custom-alert-title').innerText = title;
    document.getElementById('custom-alert-text').innerHTML = text; 
    document.getElementById('custom-alert-icon').innerText = icon;
    document.getElementById('custom-alert-modal').style.display = 'flex';
    
    const okBtn = document.getElementById('custom-alert-ok');
    const cancelBtn = document.getElementById('custom-alert-cancel');
    cancelBtn.style.display = isConfirm ? 'block' : 'none';
    
    okBtn.onclick = () => { document.getElementById('custom-alert-modal').style.display = 'none'; if (onOk) onOk(); };
    cancelBtn.onclick = () => { document.getElementById('custom-alert-modal').style.display = 'none'; };
}

function switchTab(tabId) {
    document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId + '-view').classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    
    if (tabId === 'call') {
        document.getElementById('btn-call').innerText = "🖥️ Вызов";
        if(callMode !== 'idle') {
            callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
            store.set(`unread_${targetId}`, 0);
            renderContacts(store.get('contacts') || []);
        }
    } else if (tabId === 'contacts') {
        document.getElementById('btn-contacts').innerText = "📞 Контакты";
    }
}

myId = store.get('myId');
if (!myId) {
    myId = Math.random().toString(36).substring(2, 8).toUpperCase();
    store.set('myId', myId);
    store.set('contacts', []);
}
document.getElementById('my-id-display').innerText = myId;

function checkUnknownContact(id) {
    const contacts = store.get('contacts') || [];
    const isKnown = contacts.some(c => c.id === id);
    if (!isKnown && id && id !== myId) {
        callUi.addUnknownBtn.style.display = 'inline-block';
        callUi.addUnknownBtn.onclick = () => {
            document.getElementById('add-unknown-id').value = id;
            document.getElementById('add-unknown-name').value = "Новый контакт";
            document.getElementById('add-unknown-modal').style.display = 'flex';
            document.getElementById('add-unknown-name').select();
        };
    } else {
        callUi.addUnknownBtn.style.display = 'none';
    }
}

document.getElementById('cancel-unknown-btn').addEventListener('click', () => { document.getElementById('add-unknown-modal').style.display = 'none'; });
document.getElementById('save-unknown-btn').addEventListener('click', () => {
    const name = document.getElementById('add-unknown-name').value.trim();
    const id = document.getElementById('add-unknown-id').value;
    if (!name) return; 
    
    const contacts = store.get('contacts') || [];
    contacts.push({ name: name, id: id });
    store.set('contacts', contacts);
    renderContacts(contacts);
    
    callUi.addUnknownBtn.style.display = 'none';
    document.getElementById('call-peer-name').innerText = name;
    logSys(`Контакт сохранен`);
    document.getElementById('add-unknown-modal').style.display = 'none';
});

// --- 4. АУДИО ---
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

function logSys(text) {
    const logEl = document.getElementById('sys-log-text');
    if (!logEl) return;
    logEl.innerText = "⚙️ " + text;
    logEl.style.opacity = '1';
    clearTimeout(logEl.timeout);
    logEl.timeout = setTimeout(() => { logEl.style.opacity = '0'; }, 4000);
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
        const unreadCount = store.get(`unread_${c.id}`) || 0;
        const badgeHtml = unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : '';

        li.innerHTML = `
            <div class="contact-content">
                <div class="contact-info" title="${c.name}">
                    <span class="contact-name">${c.name} ${badgeHtml}</span>
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

        li.querySelector('.contact-content').addEventListener('click', () => {
            if (li.classList.contains('show-actions')) {
                li.classList.remove('show-actions');
            } else {
                makeCall(c.id, 'chat');
            }
        });

        list.appendChild(li);
    });

    document.querySelectorAll('.btn-call-video, .btn-call-audio, .btn-call-chat').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation(); 
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

document.getElementById('cancel-edit-btn').addEventListener('click', () => { document.getElementById('edit-contact-modal').style.display = 'none'; });

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

// --- 6. СЕТЕВОЙ СЛОЙ (NTFY) ---
async function sendSignal(target, data, retryCount = 0) {
    if (currentSessionId && !data.sessionId) data.sessionId = currentSessionId;
    
    try {
        const response = await fetch(`https://ntfy.sh/p2p_call_${target}`, { 
            method: 'POST', 
            body: JSON.stringify(data) 
        });
        
        if (!response.ok && response.status === 429 && retryCount < 5) {
            setTimeout(() => sendSignal(target, data, retryCount + 1), 1500 * (retryCount + 1));
        }
    } catch (err) {
        if (retryCount < 5) {
            setTimeout(() => sendSignal(target, data, retryCount + 1), 1500 * (retryCount + 1));
        }
    }
}

function resetCallUI() {
    if (currentCallMode === 'chat') {
        if (peerConnection) { peerConnection.close(); peerConnection = null; }
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
        if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
        
        callUi.localVideo.srcObject = null; callUi.remoteVideo.srcObject = null;
        document.querySelector('.video-panel').style.display = 'none';
        
        callUi.status.innerText = 'Чат (Сервер)';
        callUi.status.style.color = '#a6adc8';
        
        document.getElementById('toggle-mic').style.opacity = '0.5';
        document.getElementById('toggle-mic').style.textDecoration = 'line-through';
        document.getElementById('toggle-cam').style.opacity = '0.5';
        document.getElementById('toggle-cam').style.textDecoration = 'line-through';
        callUi.fileLabel.style.opacity = '0.5'; callUi.fileLabel.style.pointerEvents = 'none';
        
        isVideoSwapped = false;
        isCaller = false;
        iceCandidateQueue = [];
        return; 
    }

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
    document.getElementById('emoji-picker').style.display = 'none';
    
    document.getElementById('toggle-mic').style.opacity = '1';
    document.getElementById('toggle-mic').style.textDecoration = 'none';
    document.getElementById('toggle-cam').style.opacity = '1';
    document.getElementById('toggle-cam').style.textDecoration = 'none';
    
    if (callUi.addUnknownBtn) callUi.addUnknownBtn.style.display = 'none';

    isVideoSwapped = false;
    isCaller = false;
    iceCandidateQueue = [];
    currentSessionId = null; // Сброс сессии
    
    callUi.localVideo.className = 'pip';
    callUi.remoteVideo.className = 'fullscreen';
    
    callMode = 'idle';
    wakeUpControls();
}

function loadChatHistory(id) {
    callUi.chatBox.innerHTML = '';
    chatHistory = store.get(`chat_${id}`) || [];
    chatHistory.forEach(msg => appendMsg(msg.text, msg.isMine, msg.isHtml, false, null, msg.id, msg.delivered, msg.timestamp));
}

function handleAck(msgId, peerId) {
    if (!peerId) peerId = targetId;
    let history = store.get(`chat_${peerId}`) || [];
    let updated = false;
    history = history.map(m => {
        if (m.id === msgId && !m.delivered) { m.delivered = true; updated = true; }
        return m;
    });
    if (updated) {
        store.set(`chat_${peerId}`, history);
        if (targetId === peerId) {
            const msgObj = chatHistory.find(m => m.id === msgId);
            if (msgObj) msgObj.delivered = true;
        }
    }
    const statusEl = document.getElementById(`status-${msgId}`);
    if (statusEl) statusEl.innerText = '✓✓';
}

async function forceNegotiation() {
    if (!peerConnection) return;
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendSignal(targetId, { type: 'offer', targetId, offer, from: myId });
    } catch (err) {}
}

async function getAndAddMedia(kind) {
    try {
        callUi.status.innerText = "Запуск " + (kind === 'video' ? "камеры..." : "микрофона...");
        let stream;
        if (kind === 'video') {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
            const videoTrack = stream.getVideoTracks()[0];
            if (!localStream) localStream = new MediaStream();
            localStream.addTrack(videoTrack);
            
            callUi.localVideo.srcObject = localStream;
            
            document.querySelector('.video-panel').style.display = 'flex';
            callUi.placeholder.style.display = 'none';
            
            if (peerConnection) {
                peerConnection.addTrack(videoTrack, localStream); 
                forceNegotiation();
            }
            callUi.status.innerText = "✅ Камера работает";
        } else if (kind === 'audio') {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const audioTrack = stream.getAudioTracks()[0];
            if (!localStream) localStream = new MediaStream();
            localStream.addTrack(audioTrack);
            
            if (peerConnection) {
                peerConnection.addTrack(audioTrack, localStream);
                forceNegotiation();
            }
            callUi.status.innerText = "✅ Микрофон работает";
        }
    } catch (e) {
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
    } catch (e) { 
        videoPanel.style.display = 'none';
        document.getElementById('toggle-cam').style.opacity = '0.5';
        document.getElementById('toggle-cam').style.textDecoration = 'line-through';
        document.getElementById('toggle-mic').style.opacity = '0.5';
        document.getElementById('toggle-mic').style.textDecoration = 'line-through';
    }
}

async function startChat(targetIdStr) {
    targetId = targetIdStr.toUpperCase();
    currentCallMode = 'chat';
    callMode = 'call';
    isCaller = true;
    iceCandidateQueue = [];
    currentSessionId = Math.random().toString(36).substr(2, 9); // Уникальная сессия
    
    store.set(`unread_${targetId}`, 0);
    renderContacts(store.get('contacts') || []);
    
    switchTab('call');
    
    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    checkUnknownContact(targetId);
    
    callUi.status.innerText = `Ожидание P2P...`;
    callUi.status.style.color = '#89b4fa';
    
    callUi.msgInput.disabled = false;
    callUi.sendBtn.disabled = false;
    callUi.msgInput.placeholder = "Напишите сообщение...";
    callUi.emojiBtn.style.opacity = '1';
    callUi.emojiBtn.style.pointerEvents = 'auto';
    
    loadChatHistory(targetId);
    await initMedia('chat');
    
    setupPeerConnection();
    dataChannel = peerConnection.createDataChannel('chatAndFiles');
    setupDataChannel();
    
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendSignal(targetId, { type: 'chat_offer', targetId, offer, from: myId });
    } catch (e) {}

    setTimeout(() => {
        if (callMode === 'call' && currentCallMode === 'chat' && (!peerConnection || peerConnection.connectionState !== 'connected')) {
            callUi.status.innerText = "Ожидание (оффлайн доставка активна)";
            callUi.status.style.color = "#a6adc8";
        }
    }, 12000);

    wakeUpControls();
}

async function makeCall(targetIdStr, mode) {
    if (mode === 'chat') {
        startChat(targetIdStr);
        return;
    }

    targetId = targetIdStr.toUpperCase();
    currentCallMode = mode;
    callMode = 'call'; 
    isCaller = true; 
    iceCandidateQueue = [];
    currentSessionId = Math.random().toString(36).substr(2, 9); // Уникальная сессия
    
    store.set(`unread_${targetId}`, 0);
    renderContacts(store.get('contacts') || []);
    
    switchTab('call');
    
    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    checkUnknownContact(targetId);
    
    callUi.status.innerText = `Подготовка медиа...`;
    
    loadChatHistory(targetId);
    
    await initMedia(mode);
    
    callUi.status.innerText = `Звоним...`;
    sendSignal(targetId, { type: 'ring', targetId, from: myId, callType: mode });
    playDialTone(); 
    
    ringTimeout = setTimeout(() => {
        if (!peerConnection || peerConnection.connectionState !== 'connected') {
            stopDialTone(); playHangupTone(); 
            callUi.status.innerText = "Нет ответа"; callUi.status.style.color = "#f38ba8";
            setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 3000);
        }
    }, 20000);
    
    wakeUpControls();
}

async function processIceQueue() {
    while (iceCandidateQueue.length > 0) {
        let candidate = iceCandidateQueue.shift();
        try { 
            await peerConnection.addIceCandidate(candidate); 
        } catch(e) {}
    }
}

function connectSignaling() {
    if (!myId) return;
    if (sse) sse.close();
    sse = new EventSource(`https://ntfy.sh/p2p_call_${myId}/sse?since=12h`);

    sse.onmessage = async (e) => {
        const payload = JSON.parse(e.data);
        if (payload.event !== 'message') return; 
        let msg; try { msg = JSON.parse(payload.message); } catch (err) { return; }
        if (msg.from === myId) return;

        // --- 1. ТЕКСТОВЫЕ СООБЩЕНИЯ И ГАЛОЧКИ ДОСТАВКИ (Работают всегда и фильтруются по ID) ---
        if (msg.type === 'direct_msg') {
            const senderId = msg.from;
            let history = store.get(`chat_${senderId}`) || [];
            
            // Если сообщение уже есть в истории - игнорируем
            if (history.some(m => m.id === msg.id)) return;

            // Шлем галочку доставки обратно
            sendSignal(senderId, { type: 'ack', id: msg.id, from: myId });

            checkUnknownContact(senderId);
            history.push({ id: msg.id, text: msg.text, isMine: false, isHtml: false, timestamp: msg.timestamp || Date.now(), delivered: true });
            if (history.length > 100) history.shift();
            store.set(`chat_${senderId}`, history);

            const isViewingActiveChat = callMode !== 'idle' && targetId === senderId && document.getElementById('call-view').classList.contains('active');
            
            if (isViewingActiveChat) {
                appendMsg(msg.text, false, false, false, null, msg.id, true, msg.timestamp);
                playMessageSound();
            } else {
                const currentUnread = store.get(`unread_${senderId}`) || 0;
                store.set(`unread_${senderId}`, currentUnread + 1);
                renderContacts(store.get('contacts') || []);
                
                if (callMode !== 'idle' && targetId === senderId && !document.getElementById('call-view').classList.contains('active')) {
                    document.getElementById('btn-call').innerText = "🖥️ Вызов 🔴";
                } else if (targetId !== senderId) {
                    document.getElementById('btn-contacts').innerText = "📞 Контакты 🔴";
                }

                playMessageSound();
                if (window.Notification && Notification.permission === 'granted' && document.hidden) {
                    const notif = new Notification(getContactName(senderId), { body: msg.text });
                    notif.onclick = function() { window.focus(); this.close(); };
                }
            }
            return; 
        }

        if (msg.type === 'ack') {
            handleAck(msg.id, msg.from);
            return;
        }

        // --- 2. СИСТЕМНЫЕ СИГНАЛЫ ЗВОНКА (Строгая фильтрация по Сессиям и Времени) ---
        
        // Отбрасываем старые звонки из кэша (отставание более 3 минут)
        if (msg.timestamp && Math.abs(Date.now() - msg.timestamp) > 180000) return;

        if (ringTimeout) clearTimeout(ringTimeout);

        // Игнорируем пакеты от других сессий (чужие или старые)
        if (msg.type !== 'ring' && msg.type !== 'chat_offer') {
            if (currentSessionId && msg.sessionId && msg.sessionId !== currentSessionId) return;
        }

        // Разрешение одновременного звонка (Glare)
        if ((msg.type === 'chat_offer' || msg.type === 'ring') && callMode !== 'idle') {
            if (targetId === msg.from && myId > msg.from) {
                isCaller = false; 
            } else if (targetId !== msg.from) {
                sendSignal(msg.from, { type: 'reject', targetId: msg.from, from: myId, reason: 'busy' });
                return;
            }
        }

        if (msg.type === 'chat_offer') {
            targetId = msg.from;
            callMode = 'answer';
            currentCallMode = 'chat';
            isCaller = false;
            currentSessionId = msg.sessionId;
            
            document.getElementById('call-peer-name').innerText = getContactName(targetId);
            checkUnknownContact(targetId);

            store.set(`unread_${targetId}`, 0);
            renderContacts(store.get('contacts') || []);

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
            } catch(e) {}
            return;
        }

        if (msg.type === 'ring' && callMode === 'idle') {
            targetId = msg.from; 
            callMode = 'incoming';
            currentCallMode = msg.callType || 'video';
            isCaller = false;
            iceCandidateQueue = [];
            currentSessionId = msg.sessionId;
            
            checkUnknownContact(targetId);
            
            let typeText = currentCallMode === 'video' ? '📹 ВИДЕОЗВОНОК' : (currentCallMode === 'audio' ? '📞 ГОЛОСОВОЙ ЗВОНОК' : '💬 ТЕКСТОВЫЙ ЧАТ');
            if (window.Notification && Notification.permission === 'granted' && document.hidden) {
                const notif = new Notification("Входящий вызов!", { body: `Вам звонит: ${getContactName(targetId)}` });
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
                if (currentCallMode === 'chat') return; 
                stopDialTone();
                playHangupTone();
                callUi.status.innerText = "Собеседник завершил вызов";
                callUi.status.style.color = "#f38ba8";
                setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 2000);
            }
        }

        if (msg.type === 'accept' && callMode === 'call') {
            stopDialTone(); callUi.status.innerText = "Настройка соединения...";
            setupPeerConnection(); 
            dataChannel = peerConnection.createDataChannel('chatAndFiles'); 
            setupDataChannel();
            forceNegotiation();
        }

        if (msg.type === 'reject' && callMode === 'call') {
            if (currentCallMode === 'chat') {
                callUi.status.innerText = "Чат (Сервер)";
                return;
            }
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
            if (peerConnection.signalingState !== "stable" && !isCaller) return; 

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

        if (msg.type === 'candidates' && peerConnection) {
            msg.candidates.forEach(c => {
                try {
                    const candidate = new RTCIceCandidate(c);
                    if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                        peerConnection.addIceCandidate(candidate);
                    } else {
                        iceCandidateQueue.push(candidate);
                    }
                } catch(e) {}
            });
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
    
    store.set(`unread_${targetId}`, 0);
    renderContacts(store.get('contacts') || []);

    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    callUi.status.innerText = `Подготовка медиа...`;
    
    loadChatHistory(targetId); 
    
    await initMedia(currentCallMode); 
    setupVideoSwap();
    
    callUi.status.innerText = `Соединение...`;
    sendSignal(targetId, { type: 'accept', targetId, from: myId });
    wakeUpControls();
};

document.getElementById('reject-call-btn').onclick = () => {
    stopRingtone(); callUi.incomingOverlay.style.display = 'none';
    sendSignal(targetId, { type: 'reject', targetId, from: myId }); resetCallUI();
};

// --- 7. WEBRTC P2P ЛОГИКА И ОТПРАВКА ФАЙЛОВ ---
function setupPeerConnection() {
    if (peerConnection) peerConnection.close();
    peerConnection = new RTCPeerConnection(rtcConfig);

    let candidateBuffer = [];
    let candidateTimer = null;

    if (localStream) localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = (e) => { 
        if (e.candidate) {
            candidateBuffer.push(e.candidate);
            if (!candidateTimer) {
                candidateTimer = setTimeout(() => {
                    sendSignal(targetId, { type: 'candidates', targetId, candidates: candidateBuffer, from: myId });
                    candidateBuffer = [];
                    candidateTimer = null;
                }, 1000);
            }
        }
    };

    peerConnection.onicegatheringstatechange = () => {
        if (peerConnection.iceGatheringState === 'complete' && candidateBuffer.length > 0) {
            if (candidateTimer) clearTimeout(candidateTimer);
            sendSignal(targetId, { type: 'candidates', targetId, candidates: candidateBuffer, from: myId });
            candidateBuffer = [];
            candidateTimer = null;
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
        if (peerConnection.connectionState === 'connected') {
            callUi.status.innerText = "✅ P2P соединено"; 
            callUi.status.style.color = "#a6e3a1"; 
        }
        else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
            if (currentCallMode === 'chat') {
                logSys("P2P отключен (работает сервер)");
                callUi.status.innerText = "Чат (Сервер)";
                callUi.status.style.color = "#a6adc8";
                document.querySelector('.video-panel').style.display = 'none';
            } else {
                playHangupTone();
                callUi.status.innerText = "Связь прервана";
                callUi.status.style.color = "#f38ba8";
                callUi.placeholder.style.display = 'flex';
                setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 2000);
            }
        }
    };
}

function setupDataChannel() {
    dataChannel.binaryType = 'arraybuffer';
    
    dataChannel.onopen = () => {
        callUi.status.innerText = "✅ P2P соединено"; callUi.status.style.color = "#a6e3a1"; 
        callUi.msgInput.disabled = false; callUi.sendBtn.disabled = false; 
        
        callUi.fileLabel.style.opacity = '0.8'; callUi.fileLabel.style.pointerEvents = 'auto';
        callUi.emojiBtn.style.opacity = '1'; callUi.emojiBtn.style.pointerEvents = 'auto';
    };
    
    dataChannel.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            if (incomingFileInfo) {
                fileReceiveBuffer.push(e.data);
                const receivedSize = fileReceiveBuffer.reduce((acc, val) => acc + val.byteLength, 0);
                document.getElementById('file-progress-bar').style.width = `${(receivedSize / incomingFileInfo.size) * 100}%`;
            }
            return;
        }
        
        let msg;
        try { msg = JSON.parse(e.data); } catch(err) { return; }
        
        if (msg.type === 'text') { 
            const peerId = msg.senderId || targetId; 
            
            if (dataChannel?.readyState === 'open') {
                dataChannel.send(JSON.stringify({ type: 'ack', id: msg.id }));
            }
            
            let history = store.get(`chat_${peerId}`) || [];
            if (history.some(m => m.id === msg.id)) return;

            const isViewingActiveChat = document.getElementById('call-view').classList.contains('active') && targetId === peerId;

            if (isViewingActiveChat) {
                playMessageSound(); 
                appendMsg(msg.text, false, false, true, null, msg.id, true, msg.timestamp); 
            } else {
                const currentUnread = store.get(`unread_${peerId}`) || 0;
                store.set(`unread_${peerId}`, currentUnread + 1);
                renderContacts(store.get('contacts') || []);
                
                document.getElementById('btn-call').innerText = "🖥️ Вызов 🔴";
                playMessageSound();
                
                history.push({ id: msg.id, text: msg.text, isMine: false, isHtml: false, timestamp: msg.timestamp || Date.now(), delivered: true });
                if (history.length > 100) history.shift();
                store.set(`chat_${peerId}`, history);
            }

            if (window.Notification && Notification.permission === 'granted' && document.hidden) {
                const notif = new Notification(getContactName(peerId), { body: msg.text });
                notif.onclick = function() { window.focus(); this.close(); };
            }
        }
        else if (msg.type === 'ack') {
            handleAck(msg.id, targetId);
        }
        else if (msg.type === 'file-start') {
            incomingFileInfo = msg; 
            fileReceiveBuffer = [];
            document.getElementById('file-progress-container').style.display = 'block';
            document.getElementById('file-progress-text').innerText = `Прием: ${msg.name}...`;
            document.getElementById('file-progress-bar').style.width = '0%';
        } 
        else if (msg.type === 'file-end') {
            document.getElementById('file-progress-container').style.display = 'none';
            
            const blob = new Blob(fileReceiveBuffer);
            const url = URL.createObjectURL(blob);
            
            const linkHtml = `<div style="margin-top: 5px; text-align: center;"><a href="${url}" download="${incomingFileInfo.name}" style="display: inline-block; padding: 10px 15px; background: #a6e3a1; color: #1e1e2e; text-decoration: none; font-weight: bold; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.2);">📥 Скачать файл<br><span style="font-size:10px; opacity:0.8;">${incomingFileInfo.name}</span></a></div>`;
            
            playMessageSound(); 
            appendMsg(linkHtml, false, true, true, `[Получен файл: ${incomingFileInfo.name}]`);
            
            fileReceiveBuffer = []; 
            incomingFileInfo = null;
        }
    };
}

callUi.fileInput.addEventListener('change', () => {
    const file = callUi.fileInput.files[0];
    if (!file) return;
    if (dataChannel?.readyState !== 'open') return showModal("Для передачи файлов необходимо дождаться установки P2P соединения.", "Ожидание", "⏳");
    
    if (file.size > 50 * 1024 * 1024) return showModal("Для стабильной работы на телефонах размер файла не должен превышать 50 МБ.", "Файл слишком большой", "📎");

    document.getElementById('file-progress-container').style.display = 'block';
    document.getElementById('file-progress-text').innerText = `Отправка: ${file.name}...`;
    document.getElementById('file-progress-bar').style.width = '0%';

    dataChannel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size }));

    let offset = 0;
    const reader = new FileReader();

    const sendNextChunk = () => {
        if (offset >= file.size) {
            dataChannel.send(JSON.stringify({ type: 'file-end', name: file.name }));
            document.getElementById('file-progress-container').style.display = 'none';
            appendMsg(`<i>Файл <b>${file.name}</b> отправлен</i>`, true, true, true, `[Отправлен файл: ${file.name}]`);
            callUi.fileInput.value = ''; 
            return;
        }

        if (dataChannel.bufferedAmount > 1024 * 1024) {
            setTimeout(sendNextChunk, 50);
            return;
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.onload = (e) => {
            dataChannel.send(e.target.result);
            offset += slice.size;
            document.getElementById('file-progress-bar').style.width = `${(offset / file.size) * 100}%`;
            
            if (offset % (CHUNK_SIZE * 50) === 0) {
                setTimeout(sendNextChunk, 0);
            } else {
                sendNextChunk();
            }
        };
        reader.readAsArrayBuffer(slice);
    };

    sendNextChunk();
});

async function switchCameraTrack(streamHolder, videoElement, isCall) {
    if (!streamHolder) return;
    const oldVideoTrack = streamHolder.getVideoTracks()[0];
    
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
        const newVideoTrack = newStream.getVideoTracks()[0];

        if (oldVideoTrack) {
            streamHolder.removeTrack(oldVideoTrack);
            oldVideoTrack.stop(); 
        }
        streamHolder.addTrack(newVideoTrack);

        videoElement.srcObject = streamHolder;
        videoElement.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';

        if (isCall && peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(newVideoTrack);
        }
        logSys(`Камера переключена`);
    } catch (e) {
        logSys("Ошибка переключения камеры");
        currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    }
}

document.getElementById('settings-switch-cam').onclick = () => switchCameraTrack(testStream, document.getElementById('test-video'), false);
document.getElementById('switch-cam').onclick = () => switchCameraTrack(localStream, callUi.localVideo, true);

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
    
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        showModal("Ваш браузер или мобильное устройство не поддерживает демонстрацию экрана.", "Не поддерживается", "📱");
        return;
    }

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
    } catch (e) { 
        if (e.name === 'NotAllowedError') {
            showModal("Доступ к экрану отменен или запрещен в настройках браузера.", "Отмена", "🚫");
        } else {
            logSys("Отмена экрана"); 
        }
    }
};

callUi.hangupBtn.onclick = () => {
    if (callMode !== 'idle') {
        sendSignal(targetId, { type: 'cancel', targetId, from: myId });
    }
    
    if (currentCallMode === 'chat') {
        resetCallUI();
        switchTab('contacts');
    } else {
        playHangupTone();
        callUi.status.innerText = "Завершение...";
        setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 1000); 
    }
};

function setupVideoSwap() {
    const togglePipSwap = (e) => {
        if(e) e.preventDefault(); 
        isVideoSwapped = !isVideoSwapped;
        if (isVideoSwapped) {
            callUi.localVideo.classList.remove('pip');
            callUi.localVideo.classList.add('fullscreen');
            callUi.remoteVideo.classList.remove('fullscreen');
            callUi.remoteVideo.classList.add('pip');
        } else {
            callUi.localVideo.classList.remove('fullscreen');
            callUi.localVideo.classList.add('pip');
            callUi.remoteVideo.classList.remove('pip');
            callUi.remoteVideo.classList.add('fullscreen');
        }
    };
    callUi.localVideo.addEventListener('click', togglePipSwap);
    callUi.remoteVideo.addEventListener('click', togglePipSwap);
}
setupVideoSwap();

function escapeHTML(str) { return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)); }

function appendMsg(text, isMine, isHtml = false, saveToHistory = true, rawTextForHistory = null, msgId = null, isDelivered = false, timestamp = null) {
    if (!text) return; 
    const div = document.createElement('div');
    div.className = `msg ${isMine ? 'msg-mine' : 'msg-peer'}`; 
    
    const safeText = isHtml ? text : escapeHTML(text);
    const time = new Date(timestamp || Date.now()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    let metaHtml = `<div class="msg-meta"><span>${time}</span>`;
    if (isMine && !isHtml) {
        metaHtml += `<span id="status-${msgId}" style="letter-spacing: -2px;">${isDelivered ? '✓✓' : '✓'}</span>`;
    }
    metaHtml += `</div>`;
    
    div.innerHTML = `<div class="msg-content">${safeText}</div>${metaHtml}`;
    
    callUi.chatBox.appendChild(div); 
    callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
    
    if (saveToHistory) {
        chatHistory.push({ 
            id: msgId || Date.now().toString() + Math.random().toString(36).substring(2,6), 
            text: rawTextForHistory || text, 
            isMine, 
            isHtml: false, 
            timestamp: timestamp || Date.now(),
            delivered: isDelivered 
        });
        if (chatHistory.length > 100) chatHistory.shift(); 
        store.set(`chat_${targetId}`, chatHistory);
    }
}

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
    const time = Date.now();
    
    appendMsg(text, true, false, true, null, msgId, false, time); 
    
    callUi.msgInput.value = '';
    callUi.msgInput.style.height = '40px';
    callUi.msgInput.style.overflowY = 'hidden';

    if (dataChannel?.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'text', text: text, id: msgId, senderId: myId, timestamp: time }));
    } else {
        sendSignal(targetId, { type: 'direct_msg', text: text, id: msgId, from: myId, timestamp: time });
    }
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('#contacts-list li')) {
        document.querySelectorAll('#contacts-list li').forEach(el => el.classList.remove('show-actions'));
    }
});

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        document.body.style.height = window.visualViewport.height + 'px';
        if (callMode !== 'idle') {
            callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
        }
    });
}

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

document.body.addEventListener('click', () => {
    if (window.Notification && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}, { once: true });

connectSignaling();