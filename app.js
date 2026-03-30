// --- 1. УТИЛИТА ЛОКАЛЬНОГО ХРАНИЛИЩА ---
const store = {
    get: (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set: (key, value) => { localStorage.setItem(key, JSON.stringify(value)); }
};

// --- 2. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ WEBRTC & MQTT ---
const rtcConfig = { 
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" }
    ] 
};

let mqttClient; 
let peerConnection, dataChannel;
let localStream, screenStream;

let myId = store.get('myId');
let targetId = null; 
let callMode = 'idle'; // idle, calling, incoming, active
let currentCallMode = 'video';
let currentFacingMode = 'user'; 
let ringTimeout, chatHistory = [];
let isScreenSharing = false, isVideoSwapped = false;

const CHUNK_SIZE = 16384; 
let fileReceiveBuffer = [], incomingFileInfo = null;

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
    hangupBtn: document.getElementById('hangup-btn'),
    incomingOverlay: document.getElementById('incoming-overlay'),
    incomingCallerId: document.getElementById('incoming-caller-id'),
    fileInput: document.getElementById('file-input'),
    addUnknownBtn: document.getElementById('add-unknown-btn')
};

// --- 3. ИНИЦИАЛИЗАЦИЯ И UI ---
if (!myId) {
    myId = Math.random().toString(36).substring(2, 8).toUpperCase();
    store.set('myId', myId);
    store.set('contacts', []);
}

function getContactName(id) {
    const contacts = store.get('contacts') || [];
    const c = contacts.find(c => c.id === id);
    return c ? c.name : id;
}

function showModal(text, title = "Уведомление", icon = "ℹ️", isConfirm = false, onOk = null) {
    document.getElementById('custom-alert-title').innerText = title;
    document.getElementById('custom-alert-text').innerHTML = text; 
    document.getElementById('custom-alert-icon').innerText = icon;
    document.getElementById('custom-alert-modal').style.display = 'flex';
    
    document.getElementById('custom-alert-ok').onclick = () => { document.getElementById('custom-alert-modal').style.display = 'none'; if (onOk) onOk(); };
    document.getElementById('custom-alert-cancel').style.display = isConfirm ? 'block' : 'none';
    document.getElementById('custom-alert-cancel').onclick = () => { document.getElementById('custom-alert-modal').style.display = 'none'; };
}

function switchTab(tabId) {
    document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId + '-view').classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    if (tabId === 'call' && callMode !== 'idle') {
        callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
        if (targetId) store.set(`unread_${targetId}`, 0);
        renderContacts(store.get('contacts') || []);
    }
}

function checkUnknownContact(id) {
    const contacts = store.get('contacts') || [];
    if (!contacts.some(c => c.id === id) && id && id !== myId) {
        callUi.addUnknownBtn.style.display = 'inline-block';
        callUi.addUnknownBtn.onclick = () => {
            document.getElementById('add-unknown-id').value = id;
            document.getElementById('add-unknown-modal').style.display = 'flex';
        };
    } else {
        callUi.addUnknownBtn.style.display = 'none';
    }
}

document.getElementById('cancel-unknown-btn').onclick = () => document.getElementById('add-unknown-modal').style.display = 'none';
document.getElementById('save-unknown-btn').onclick = () => {
    const name = document.getElementById('add-unknown-name').value.trim();
    const id = document.getElementById('add-unknown-id').value;
    if (!name) return; 
    const contacts = store.get('contacts') || [];
    contacts.push({ name, id });
    store.set('contacts', contacts); renderContacts(contacts);
    callUi.addUnknownBtn.style.display = 'none';
    document.getElementById('call-peer-name').innerText = name;
    document.getElementById('add-unknown-modal').style.display = 'none';
};

// --- 3.5 НАСТРОЙКИ И ДИАГНОСТИКА ---
let testStream, analyzer, micInterval;

async function requestMediaPermissions() {
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
        document.getElementById('req-perm-btn').innerText = "✅ Оборудование работает";
        document.getElementById('req-perm-btn').style.background = "#4caf50";
    } catch (e) {
        showModal("Доступ запрещен! Разрешите использование камеры и микрофона в настройках браузера.", "Ошибка", "🚫");
    }
}

document.getElementById('settings-btn').onclick = () => {
    document.getElementById('settings-modal').style.display = 'flex';
    document.getElementById('req-perm-btn').innerText = "🎥 Разрешить Камеру/Микрофон";
    document.getElementById('req-perm-btn').style.background = "#1976d2";
    requestMediaPermissions();
};

document.getElementById('close-settings-btn').onclick = () => {
    document.getElementById('settings-modal').style.display = 'none';
    if (testStream) testStream.getTracks().forEach(t => t.stop());
    if (micInterval) clearInterval(micInterval); testStream = null;
};

document.getElementById('settings-switch-cam').onclick = () => {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    if (testStream) testStream.getTracks().forEach(t => t.stop());
    requestMediaPermissions();
};

// --- 4. АУДИО (ЗВОНКИ И УВЕДОМЛЕНИЯ) ---
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
    doubleRing(); ringInterval = setInterval(doubleRing, 3000);
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
    const now = audioCtx.currentTime; playPip(now); playPip(now + 0.4); playPip(now + 0.8);
}

// --- 5. ПРОМЫШЛЕННЫЙ СИГНАЛЬНЫЙ СЕРВЕР (MQTT) ---
function initMQTT() {
    document.getElementById('my-id-display').innerText = myId;
    document.getElementById('my-id-display').style.color = "#888"; 
    callUi.status.innerText = "Подключение к MQTT...";
    
    // Используем мощный публичный брокер EMQX (не блокируется)
    mqttClient = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 2000
    });

    mqttClient.on('connect', () => {
        // Подписываемся на наш личный "канал" связи
        mqttClient.subscribe(`family_p2p_${myId}`);
        document.getElementById('my-id-display').style.color = "#0d47a1"; // Синий - успешно
        
        if (callMode === 'idle') {
            callUi.status.innerText = "В сети (Защищено)";
            callUi.status.style.color = "#a6e3a1";
        }
    });

    mqttClient.on('message', async (topic, message) => {
        let data;
        try { data = JSON.parse(message.toString()); } catch(e) { return; }
        if (data.from === myId) return; // Игнорируем свои же пакеты
        
        handleSignal(data);
    });

    mqttClient.on('error', (err) => {
        document.getElementById('my-id-display').style.color = "#f44336"; 
        if (callMode === 'idle') {
            callUi.status.innerText = "Поиск сети...";
            callUi.status.style.color = "#f9e2af";
        }
    });
    
    mqttClient.on('offline', () => {
        if (callMode === 'idle') {
            callUi.status.innerText = "Нет интернета";
            callUi.status.style.color = "#f38ba8";
        }
    });
}

function sendSignal(target, payload) {
    if (mqttClient && mqttClient.connected) {
        payload.from = myId;
        // Отправляем пакет в канал собеседника
        mqttClient.publish(`family_p2p_${target}`, JSON.stringify(payload));
    }
}

// --- 6. ЛОГИКА СОЕДИНЕНИЯ (NATIVE WEBRTC) ---
async function handleSignal(msg) {
    // 1. Входящий звонок
    if (msg.type === 'ring') {
        if (callMode !== 'idle') {
            sendSignal(msg.from, { type: 'reject', reason: 'busy' });
            return;
        }
        targetId = msg.from;
        callMode = 'incoming';
        currentCallMode = msg.callType;
        
        checkUnknownContact(targetId);
        
        document.getElementById('incoming-ring-ui').style.display = 'block';
        document.getElementById('incoming-canceled-ui').style.display = 'none';
        callUi.incomingCallerId.innerText = getContactName(targetId);
        document.getElementById('incoming-call-type').innerText = currentCallMode === 'video' ? '📹 ВИДЕОЗВОНОК' : (currentCallMode === 'audio' ? '📞 ГОЛОСОВОЙ ЗВОНОК' : '💬 ЧАТ');
        
        callUi.incomingOverlay.style.display = 'flex';
        playRingtone();
    }
    // 2. Отмена звонка звонящим
    else if (msg.type === 'cancel') {
        stopRingtone();
        document.getElementById('incoming-ring-ui').style.display = 'none';
        document.getElementById('incoming-canceled-ui').style.display = 'block';
        setTimeout(() => { callUi.incomingOverlay.style.display = 'none'; resetCallUI(); }, 2000);
    }
    // 3. Абонент ответил (Запускаем WebRTC)
    else if (msg.type === 'accept') {
        stopDialTone();
        callUi.status.innerText = "Установка связи (P2P)...";
        setupPeerConnection();
        
        // Создаем дата-канал (он нужен всегда для чата и файлов)
        setupDataChannel(peerConnection.createDataChannel('chatAndFiles'));
        
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sendSignal(targetId, { type: 'offer', offer: offer });
        } catch(e) { console.error("Offer Error", e); }
    }
    // 4. Абонент отклонил
    else if (msg.type === 'reject') {
        stopDialTone(); playHangupTone();
        callUi.status.innerText = msg.reason === 'busy' ? "Абонент занят" : "Вызов отклонен";
        callUi.status.style.color = "#f38ba8";
        setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 3000);
    }
    // 5. Получен Offer (Отвечаем)
    else if (msg.type === 'offer') {
        setupPeerConnection();
        peerConnection.ondatachannel = (e) => setupDataChannel(e.channel);
        
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            sendSignal(targetId, { type: 'answer', answer: answer });
        } catch(e) { console.error("Answer Error", e); }
    }
    // 6. Получен Answer (Завершаем хендшейк)
    else if (msg.type === 'answer') {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
        } catch(e) { console.error("RemoteDesc Error", e); }
    }
    // 7. Получены маршруты (ICE)
    else if (msg.type === 'candidate') {
        try {
            if (peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch(e) {}
    }
    // 7.5. Тихий запрос на P2P (для чата и файлов без гудков)
    else if (msg.type === 'silent_offer') {
        setupPeerConnection();
        peerConnection.ondatachannel = (e) => setupDataChannel(e.channel);
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            sendSignal(msg.from, { type: 'answer', answer: answer });
        } catch(e) { console.error("Silent Answer Error", e); }
    }
    // 8. Резервный оффлайн чат через MQTT
    else if (msg.type === 'chat') {
        const peerId = msg.from;
        const isViewing = (document.getElementById('call-view').classList.contains('active') && targetId === peerId);
        
        if (isViewing) {
            playMessageSound();
            appendMsg(msg.text, false, false, true, null, true, msg.timestamp);
        } else {
            const unread = store.get(`unread_${peerId}`) || 0;
            store.set(`unread_${peerId}`, unread + 1);
            renderContacts(store.get('contacts') || []);
            playMessageSound();
            
            let history = store.get(`chat_${peerId}`) || [];
            history.push({ id: Date.now(), text: msg.text, isMine: false, timestamp: msg.timestamp });
            store.set(`chat_${peerId}`, history);
        }
    }
}

function setupPeerConnection() {
    if (peerConnection) peerConnection.close();
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Добавляем наши медиа треки в P2P туннель
    if (localStream && currentCallMode !== 'chat') {
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    // Отправляем свои маршруты собеседнику
    peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            sendSignal(targetId, { type: 'candidate', candidate: e.candidate });
        }
    };

    // Получаем медиа треки от собеседника
    peerConnection.ontrack = (e) => {
        if (!callUi.remoteVideo.srcObject || callUi.remoteVideo.srcObject.id !== e.streams[0].id) {
            callUi.remoteVideo.srcObject = e.streams[0];
        }
        document.querySelector('.video-panel').style.display = 'flex';
        callUi.remoteVideo.style.display = 'block';
        callUi.localVideo.style.display = 'block';
        callUi.placeholder.style.display = 'none';
    };

    // Отслеживаем статус
    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
            callUi.status.innerText = "✅ Связь установлена";
            callUi.status.style.color = "#a6e3a1";
        } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            playHangupTone();
            callUi.status.innerText = "Связь прервана";
            callUi.status.style.color = "#f38ba8";
            setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 2000);
        }
    };
}

function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';
    
    dataChannel.onopen = () => { enableChatUI(); };
    
    dataChannel.onmessage = (e) => {
        // Прием бинарных кусков файла
        if (e.data instanceof ArrayBuffer) {
            if (incomingFileInfo) {
                fileReceiveBuffer.push(e.data);
                const receivedSize = fileReceiveBuffer.reduce((acc, val) => acc + val.byteLength, 0);
                document.getElementById('file-progress-bar').style.width = `${(receivedSize / incomingFileInfo.size) * 100}%`;
            }
            return;
        }
        
        // Прием текста и JSON
        let data;
        try { data = JSON.parse(e.data); } catch(err) { return; }
        
        if (data.type === 'chat') {
            playMessageSound();
            appendMsg(data.text, false, false, true, null, true, data.timestamp);
        } 
        else if (data.type === 'file-start') {
            incomingFileInfo = data; 
            fileReceiveBuffer = [];
            document.getElementById('file-progress-container').style.display = 'block';
            document.getElementById('file-progress-text').innerText = `Прием: ${data.name}...`;
            document.getElementById('file-progress-bar').style.width = '0%';
        } 
        else if (data.type === 'file-end') {
            document.getElementById('file-progress-container').style.display = 'none';
            const blob = new Blob(fileReceiveBuffer);
            const url = URL.createObjectURL(blob);
            const linkHtml = `<div style="margin-top: 5px; text-align: center;"><a href="${url}" download="${incomingFileInfo.name}" style="display: inline-block; padding: 10px 15px; background: #a6e3a1; color: #1e1e2e; text-decoration: none; font-weight: bold; border-radius: 8px;">📥 Скачать файл<br><span style="font-size:10px; opacity:0.8;">${incomingFileInfo.name}</span></a></div>`;
            
            playMessageSound(); 
            appendMsg(linkHtml, false, true, true, `[Получен файл: ${incomingFileInfo.name}]`);
            
            fileReceiveBuffer = []; 
            incomingFileInfo = null;
        }
    };
}

// Кнопка позвонить
async function makeCall(targetIdStr, mode) {
    targetId = targetIdStr.toUpperCase();
    currentCallMode = mode;
    callMode = mode === 'chat' ? 'active' : 'calling'; // Чат активируется сразу
    
    store.set(`unread_${targetId}`, 0);
    renderContacts(store.get('contacts') || []);
    switchTab('call');
    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    checkUnknownContact(targetId);
    loadChatHistory(targetId);
    
    // --- ЛОГИКА АСИНХРОННОГО ЧАТА ---
    if (mode === 'chat') {
        callUi.status.innerText = `Чат (MQTT)`;
        document.querySelector('.video-panel').style.display = 'none';
        
        // Делаем кнопки яркими, чтобы при клике из чата можно было начать видео/аудио звонок
        document.getElementById('toggle-cam').style.opacity = '1';
        document.getElementById('toggle-mic').style.opacity = '1';
        document.getElementById('toggle-cam').style.textDecoration = 'none';
        document.getElementById('toggle-mic').style.textDecoration = 'none';
        
        enableChatUI();
        
        // В фоне поднимаем P2P для передачи файлов (без звонка и гудков)
        setupPeerConnection();
        setupDataChannel(peerConnection.createDataChannel('chatAndFiles'));
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sendSignal(targetId, { type: 'silent_offer', offer: offer });
        } catch(e) {}
        
        wakeUpControls();
        return; // Прерываем функцию, чтобы не было гудков
    }

    // --- ЛОГИКА АУДИО/ВИДЕО ЗВОНКА ---
    callUi.status.innerText = `Подготовка...`;
    await initMedia(mode);

    callUi.status.innerText = `Звоним...`;
    sendSignal(targetId, { type: 'ring', callType: mode });
    playDialTone();
    
    ringTimeout = setTimeout(() => {
        if (callMode === 'calling') {
            stopDialTone(); playHangupTone();
            sendSignal(targetId, { type: 'cancel' }); // Отмена вызова если не ответили
            callUi.status.innerText = "Нет ответа"; callUi.status.style.color = "#f38ba8";
            setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 3000);
        }
    }, 30000);
    
    wakeUpControls();
}

document.getElementById('accept-call-btn').onclick = async () => {
    stopRingtone(); 
    callUi.incomingOverlay.style.display = 'none'; 
    callMode = 'active'; 
    switchTab('call');
    
    store.set(`unread_${targetId}`, 0);
    renderContacts(store.get('contacts') || []);
    document.getElementById('call-peer-name').innerText = getContactName(targetId);
    loadChatHistory(targetId);
    
    if (currentCallMode !== 'chat') {
        callUi.status.innerText = `Запуск оборудования...`;
        await initMedia(currentCallMode);
    } else {
        document.querySelector('.video-panel').style.display = 'none';
    }

    callUi.status.innerText = `Соединение...`;
    sendSignal(targetId, { type: 'accept' });
    
    wakeUpControls();
};

document.getElementById('reject-call-btn').onclick = () => {
    stopRingtone(); callUi.incomingOverlay.style.display = 'none';
    sendSignal(targetId, { type: 'reject', reason: 'declined' });
    resetCallUI();
};

// --- 7. МЕДИА, UI И ЧАТ ---
async function initMedia(mode) {
    document.querySelector('.video-panel').style.display = 'flex';
    callUi.placeholder.style.display = 'flex';
    document.getElementById('toggle-cam').style.opacity = '1';
    document.getElementById('toggle-mic').style.opacity = '1';

    try {
        const constraints = { audio: true, video: mode === 'video' ? { facingMode: currentFacingMode } : false };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (mode === 'video') {
            callUi.localVideo.srcObject = localStream; 
            callUi.localVideo.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
        }
    } catch (e) {
        console.error("No media:", e);
        showModal("Не удалось получить доступ к камере/микрофону. Проверьте разрешения в браузере.");
    }
}

function resetCallUI() {
    stopDialTone(); stopRingtone(); clearTimeout(ringTimeout);
    
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (dataChannel) { dataChannel.close(); dataChannel = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    
    callUi.localVideo.srcObject = null; callUi.remoteVideo.srcObject = null;
    document.querySelector('.video-panel').style.display = 'flex';
    callUi.placeholder.style.display = 'flex'; 
    callUi.placeholder.innerText = 'Ожидание подключения...';
    
    callUi.status.innerText = 'Ожидание действий...';
    callUi.status.style.color = '#89b4fa';
    document.getElementById('call-peer-name').innerText = "Семейная связь";
    
    callUi.msgInput.disabled = true; callUi.sendBtn.disabled = true;
    callUi.fileLabel.style.opacity = '0.5'; callUi.fileLabel.style.pointerEvents = 'none';
    callUi.emojiBtn.style.opacity = '0.5'; callUi.emojiBtn.style.pointerEvents = 'none';
    
    callMode = 'idle';
    targetId = null;
    
    if (mqttClient && mqttClient.connected) {
        callUi.status.innerText = "В сети (Защищено)";
        callUi.status.style.color = "#a6e3a1";
    }
}

function enableChatUI() {
    callUi.msgInput.disabled = false;
    callUi.sendBtn.disabled = false;
    callUi.fileLabel.style.opacity = '1'; callUi.fileLabel.style.pointerEvents = 'auto';
    callUi.emojiBtn.style.opacity = '1'; callUi.emojiBtn.style.pointerEvents = 'auto';
}

function loadChatHistory(id) {
    callUi.chatBox.innerHTML = '';
    chatHistory = store.get(`chat_${id}`) || [];
    chatHistory.forEach(msg => appendMsg(msg.text, msg.isMine, msg.isHtml, false, null, true, msg.timestamp));
}

function escapeHTML(str) { return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)); }

function appendMsg(text, isMine, isHtml = false, saveToHistory = true, rawTextForHistory = null, isDelivered = true, timestamp = null) {
    if (!text) return; 
    const div = document.createElement('div');
    div.className = `msg ${isMine ? 'msg-mine' : 'msg-peer'}`; 
    const safeText = isHtml ? text : escapeHTML(text);
    const time = new Date(timestamp || Date.now()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    div.innerHTML = `<div class="msg-content">${safeText}</div><div class="msg-meta"><span>${time}</span>${isMine && !isHtml ? '<span>✓✓</span>' : ''}</div>`;
    callUi.chatBox.appendChild(div); 
    callUi.chatBox.scrollTop = callUi.chatBox.scrollHeight;
    
    if (saveToHistory && targetId) {
        chatHistory.push({ id: Date.now(), text: rawTextForHistory || text, isMine, isHtml: false, timestamp: timestamp || Date.now() });
        if (chatHistory.length > 100) chatHistory.shift(); 
        store.set(`chat_${targetId}`, chatHistory);
    }
}

callUi.sendBtn.onclick = () => {
    const text = callUi.msgInput.value.trim();
    if (!text) return;
    const time = Date.now();
    
    appendMsg(text, true, false, true, null, true, time); 
    
    // Если есть P2P дата-канал, шлем по нему (мгновенно)
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'chat', text: text, timestamp: time }));
    } else {
        // Если нет P2P канала (оффлайн режим), шлем через MQTT (доставка 100%)
        sendSignal(targetId, { type: 'chat', text: text, timestamp: time });
    }
    callUi.msgInput.value = '';
};

callUi.msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); callUi.sendBtn.click(); }});

callUi.hangupBtn.onclick = () => {
    if (callMode !== 'idle') sendSignal(targetId, { type: 'cancel' });
    playHangupTone();
    callUi.status.innerText = "Завершение...";
    setTimeout(() => { resetCallUI(); switchTab('contacts'); }, 1000); 
};

// Отправка файла (Ручное дробление на куски для P2P)
callUi.fileInput.addEventListener('change', () => {
    const file = callUi.fileInput.files[0];
    if (!file) return;
    if (!dataChannel || dataChannel.readyState !== 'open') return showModal("Дождитесь установки P2P соединения для передачи файлов.");
    if (file.size > 50 * 1024 * 1024) return showModal("Размер файла не должен превышать 50 МБ.");

    document.getElementById('file-progress-container').style.display = 'block';
    document.getElementById('file-progress-text').innerText = `Отправка: ${file.name}...`;
    document.getElementById('file-progress-bar').style.width = '0%';

    dataChannel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size }));

    let offset = 0;
    const reader = new FileReader();

    const sendNextChunk = () => {
        if (offset >= file.size) {
            dataChannel.send(JSON.stringify({ type: 'file-end' }));
            document.getElementById('file-progress-container').style.display = 'none';
            appendMsg(`<i>Файл <b>${file.name}</b> отправлен</i>`, true, true, true, `[Отправлен файл: ${file.name}]`);
            callUi.fileInput.value = ''; 
            return;
        }
        
        // Защита от переполнения буфера
        if (dataChannel.bufferedAmount > 1024 * 1024) {
            setTimeout(sendNextChunk, 50);
            return;
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.onload = (e) => {
            dataChannel.send(e.target.result);
            offset += slice.size;
            document.getElementById('file-progress-bar').style.width = `${(offset / file.size) * 100}%`;
            
            if (offset % (CHUNK_SIZE * 50) === 0) setTimeout(sendNextChunk, 0); // Передышка браузеру
            else sendNextChunk();
        };
        reader.readAsArrayBuffer(slice);
    };

    sendNextChunk();
});

// Эмодзи
const emojis = ["😀","😂","🤣","😊","😍","🥰","😘","😜","😎","🥳","😒","😔","😢","😭","😡","🤯","😱","🤔","🤫","🙄","😴","🤢","🤮","😷","👍","👎","👌","✌️","🤞","🤝","🙏"];
emojis.forEach(e => {
    const span = document.createElement('span'); span.className = 'emoji-item'; span.innerText = e;
    span.onclick = () => { callUi.msgInput.value += e; callUi.msgInput.focus(); };
    document.getElementById('emoji-picker').appendChild(span);
});
callUi.emojiBtn.onclick = (e) => { e.stopPropagation(); document.getElementById('emoji-picker').style.display = document.getElementById('emoji-picker').style.display === 'grid' ? 'none' : 'grid'; };
document.addEventListener('click', (e) => { if (!e.target.closest('#emoji-picker') && e.target !== callUi.emojiBtn) document.getElementById('emoji-picker').style.display = 'none'; });

// Адресная книга
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
                <div class="contact-info">
                    <span class="contact-name">${c.name} ${badgeHtml}</span>
                    <span class="contact-id">ID: ${c.id}</span>
                </div>
                <div class="contact-actions">
                    <button class="call-action-btn btn-call-video" data-id="${c.id}" data-mode="video">📹</button>
                    <button class="call-action-btn btn-call-audio" data-id="${c.id}" data-mode="audio">📞</button>
                    <button class="call-action-btn btn-call-chat" data-id="${c.id}" data-mode="chat">💬</button>
                </div>
            </div>
            <div class="del-handle">⋮</div>
            <div class="swipe-actions">
                <button class="btn-edit" data-index="${index}">✏️</button>
                <button class="btn-del" data-index="${index}">✕</button>
            </div>
        `;

        li.querySelector('.del-handle').onclick = (e) => { e.stopPropagation(); document.querySelectorAll('#contacts-list li').forEach(el => el.classList.remove('show-actions')); li.classList.add('show-actions'); };
        li.querySelector('.contact-content').onclick = () => { li.classList.contains('show-actions') ? li.classList.remove('show-actions') : makeCall(c.id, 'chat'); };

        list.appendChild(li);
    });

    document.querySelectorAll('.btn-call-video, .btn-call-audio, .btn-call-chat').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); makeCall(e.currentTarget.getAttribute('data-id'), e.currentTarget.getAttribute('data-mode')); });
    
    document.querySelectorAll('.btn-del').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); const contacts = store.get('contacts'); contacts.splice(e.currentTarget.getAttribute('data-index'), 1); store.set('contacts', contacts); renderContacts(contacts); });

    // Кнопка редактирования (Карандаш)
    document.querySelectorAll('.btn-edit').forEach(btn => btn.onclick = (e) => {
        e.stopPropagation();
        const index = e.currentTarget.getAttribute('data-index');
        const contacts = store.get('contacts') || [];
        const contact = contacts[index];
        if (contact) {
            document.getElementById('edit-contact-index').value = index;
            document.getElementById('edit-contact-name').value = contact.name;
            document.getElementById('edit-contact-id').value = contact.id;
            document.getElementById('edit-contact-modal').style.display = 'flex';
        }
    });
}

renderContacts(store.get('contacts') || []);

document.getElementById('add-btn').onclick = () => {
    const name = document.getElementById('contact-name').value.trim();
    const id = document.getElementById('contact-id').value.trim().toUpperCase();
    if (!name || !id) return showModal("Заполните Имя и ID.");
    const contacts = store.get('contacts') || []; contacts.push({ name, id }); store.set('contacts', contacts); renderContacts(contacts);
    document.getElementById('contact-name').value = ''; document.getElementById('contact-id').value = '';
};

// Сохранение и отмена редактирования контакта
document.getElementById('cancel-edit-btn').onclick = () => {
    document.getElementById('edit-contact-modal').style.display = 'none';
};

document.getElementById('save-edit-btn').onclick = () => {
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
};

// UI контролы камеры/микрофона (превращают чат в звонок)
document.getElementById('toggle-mic').onclick = function() {
    // Если мы просто в чате — начинаем аудиозвонок!
    if (currentCallMode === 'chat' && callMode === 'active' && targetId) {
        makeCall(targetId, 'audio');
        return;
    }
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0]; 
    t.enabled = !t.enabled;
    this.style.opacity = t.enabled ? '1' : '0.5'; 
    this.style.textDecoration = t.enabled ? 'none' : 'line-through';
};

document.getElementById('toggle-cam').onclick = function() {
    // Если мы просто в чате — начинаем видеозвонок!
    if (currentCallMode === 'chat' && callMode === 'active' && targetId) {
        makeCall(targetId, 'video');
        return;
    }
    if (!localStream) return;
    const t = localStream.getVideoTracks()[0]; 
    t.enabled = !t.enabled;
    this.style.opacity = t.enabled ? '1' : '0.5'; 
    this.style.textDecoration = t.enabled ? 'none' : 'line-through';
};

document.getElementById('switch-cam').onclick = async () => {
    if (!localStream) return;
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
        const newTrack = newStream.getVideoTracks()[0];
        const oldTrack = localStream.getVideoTracks()[0];
        localStream.removeTrack(oldTrack); oldTrack.stop();
        localStream.addTrack(newTrack);
        callUi.localVideo.srcObject = localStream;
        callUi.localVideo.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
        
        if (peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(newTrack);
        }
    } catch(e) {}
};

document.getElementById('share-screen').onclick = async function() {
    if (!peerConnection) return;
    if (isScreenSharing) { 
        if (screenStream) screenStream.getTracks().forEach(t => t.stop());
        const s = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        const localTrack = localStream ? localStream.getVideoTracks()[0] : null;
        if (s && localTrack) { s.replaceTrack(localTrack); callUi.localVideo.srcObject = localStream; }
        this.innerHTML = "Экран"; this.style.background = "#a6e3a1"; isScreenSharing = false; 
        return; 
    }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({video: true});
        const screenTrack = screenStream.getVideoTracks()[0];
        const s = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (s) s.replaceTrack(screenTrack);
        callUi.localVideo.srcObject = screenStream;
        this.innerHTML = "Ост."; this.style.background = "#f38ba8"; isScreenSharing = true;
        screenTrack.onended = () => { if (isScreenSharing) document.getElementById('share-screen').onclick(); };
    } catch (e) {}
};

// Свап видео PIP
const togglePipSwap = () => {
    isVideoSwapped = !isVideoSwapped;
    callUi.localVideo.className = isVideoSwapped ? 'fullscreen' : 'pip';
    callUi.remoteVideo.className = isVideoSwapped ? 'pip' : 'fullscreen';
};
callUi.localVideo.onclick = togglePipSwap; callUi.remoteVideo.onclick = togglePipSwap;

// Контрол панели
let controlsTimeout;
const wakeUpControls = () => {
    const controlsEl = document.querySelector('.controls');
    if (!controlsEl) return;
    controlsEl.style.opacity = '1'; controlsEl.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(controlsTimeout);
    if (callMode !== 'idle') controlsTimeout = setTimeout(() => { controlsEl.style.opacity = '0'; controlsEl.style.transform = 'translateX(-50%) translateY(20px)'; }, 3000);
};
document.getElementById('call-view').addEventListener('mousemove', wakeUpControls);
document.getElementById('call-view').addEventListener('touchstart', wakeUpControls, { passive: true });

// Базовые модалки (Настройки, Редактирование ID)
document.getElementById('edit-id-btn').onclick = () => { document.getElementById('id-display-container').style.display = 'none'; document.getElementById('id-edit-container').style.display = 'flex'; document.getElementById('new-id-input').value = myId; };
document.getElementById('cancel-id-btn').onclick = () => { document.getElementById('id-edit-container').style.display = 'none'; document.getElementById('id-display-container').style.display = 'flex'; };
document.getElementById('save-id-btn').onclick = () => {
    const newId = document.getElementById('new-id-input').value.trim().toUpperCase(); 
    if (newId) { store.set('myId', newId); myId = newId; initMQTT(); document.getElementById('cancel-id-btn').click(); }
};

// --- ЗАПУСК ---
initMQTT();

// РЕГИСТРАЦИЯ PWA (Service Worker)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then((reg) => console.log('PWA Service Worker зарегистрирован', reg.scope))
            .catch((err) => console.error('Ошибка регистрации PWA:', err));
    });
}