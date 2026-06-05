// -------------------------- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ --------------------------
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'gemma3:4b';

let db = null;
let allPeople = [];
let userProfile = { id: 'main', name: null, description: null, timeline: [] };
let recognition = null;
let isListening = false;

const profilesList = document.getElementById('profilesList');
const chatMessages = document.getElementById('chatMessages');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const voiceBtn = document.getElementById('voiceBtn');
const voiceStatus = document.getElementById('voiceStatus');

// -------------------------- БАЗА ДАННЫХ (IDB) --------------------------
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('CommuniDB', 3);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('people'))
                db.createObjectStore('people', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('user'))
                db.createObjectStore('user', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('facts'))
                db.createObjectStore('facts', { keyPath: 'id', autoIncrement: true });
            if (!db.objectStoreNames.contains('chatHistory'))
                db.createObjectStore('chatHistory', { keyPath: 'id', autoIncrement: true });
        };
    });
}

async function savePeople(peopleArray) {
    const db = await openDB();
    const tx = db.transaction('people', 'readwrite');
    const store = tx.objectStore('people');
    for (let p of peopleArray) store.put(p);
    await tx.complete;
}

async function loadAllPeople() {
    const db = await openDB();
    const tx = db.transaction('people', 'readonly');
    const store = tx.objectStore('people');
    return await new Promise((res, rej) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

async function saveUser(profile) {
    const db = await openDB();
    const tx = db.transaction('user', 'readwrite');
    const store = tx.objectStore('user');
    await store.put(profile);
    await tx.complete;
}

async function loadUser() {
    const db = await openDB();
    const tx = db.transaction('user', 'readonly');
    const store = tx.objectStore('user');
    const res = await new Promise((resolve) => {
        const req = store.get('main');
        req.onsuccess = () => resolve(req.result);
    });
    return res || null;
}

async function saveFact(factText) {
    const db = await openDB();
    const tx = db.transaction('facts', 'readwrite');
    const store = tx.objectStore('facts');
    await store.add({ text: factText, timestamp: Date.now() });
    await tx.complete;
}

async function loadRecentFacts(limit = 20) {
    const db = await openDB();
    const tx = db.transaction('facts', 'readonly');
    const store = tx.objectStore('facts');
    const all = await new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
    });
    all.sort((a,b) => b.timestamp - a.timestamp);
    return all.slice(0, limit).map(f => f.text);
}

async function saveChatMessage(role, content) {
    const db = await openDB();
    const tx = db.transaction('chatHistory', 'readwrite');
    const store = tx.objectStore('chatHistory');
    await store.add({ role, content, timestamp: Date.now() });
    await tx.complete;
}

async function loadChatHistory(limit = 50) {
    const db = await openDB();
    const tx = db.transaction('chatHistory', 'readonly');
    const store = tx.objectStore('chatHistory');
    const all = await new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
    });
    all.sort((a,b) => a.timestamp - b.timestamp);
    return all.slice(-limit);
}

// -------------------------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ --------------------------
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        return '&gt;';
    });
}

function isSimilarName(a, b) {
    if (!a || !b) return false;
    const la = a.toLowerCase().replace(/\s+/g, ' ');
    const lb = b.toLowerCase().replace(/\s+/g, ' ');
    return la === lb || la.includes(lb) || lb.includes(la);
}

// -------------------------- ПРОВЕРКА OLLAMA --------------------------
async function isOllamaAlive() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const resp = await fetch('http://localhost:11434', { signal: controller.signal });
        clearTimeout(timeout);
        return resp.ok;
    } catch { return false; }
}

async function checkModel() {
    try {
        const resp = await fetch('http://localhost:11434/api/tags');
        const data = await resp.json();
        return data.models && data.models.some(m => m.name === OLLAMA_MODEL);
    } catch { return false; }
}

// -------------------------- ОСНОВНОЙ ЗАПРОС К LLM --------------------------
async function askOllama(userText) {
    const recentFacts = await loadRecentFacts(15);
    const recentChat = await loadChatHistory(10);
    const peopleContext = allPeople.map(p => {
        return `${p.name} (оценка: ${p.rating?.value ?? '?'}) — ${p.description || 'нет описания'}`;
    }).join('\n');

    const systemPrompt = `Ты — ассистент Communi. У тебя есть память о людях, фактах и диалогах.

## КОНТЕКСТ (ТВОЯ ПАМЯТЬ)

### Люди, которых ты уже знаешь:
${peopleContext || 'Пока никого'}

### Факты, которые просили запомнить:
${recentFacts.join('\n') || 'Нет'}

### Последние сообщения из чата:
${recentChat.map(m => `${m.role === 'user' ? 'ПОЛЬЗОВАТЕЛЬ' : 'ТЫ'}: ${m.content}`).join('\n')}

---

## ТВОЯ ЗАДАЧА

Проанализируй новое сообщение пользователя. Ты должен:
1. **Ответить пользователю**, дружелюбно, но без лишних приветствий.
2. **Заканчивай свой ответ вопросом**, чтобы продолжить диалог.
3. Извлеки информацию о людях: имена, поступки, описание, оценку.
4. Запомни новые факты, если пользователь просит.

## ПРАВИЛА ОБНОВЛЕНИЯ ОПИСАНИЯ
- Описание человека должно быть связным и включать все известные факты.
- Если действие причинило физический вред, максимальная оценка — 6/10.
- Никогда не создавай профиль для пользователя.

## ФОРМАТ ВЫВОДА
Сначала напиши свой обычный ответ. Затем с новой строки "###JSON", а на следующей строке — JSON.

Пример:
###JSON
{
  "people": [
    {
      "name": "Имя Фамилия",
      "description": "Характеристика",
      "event": "Конкретное действие",
      "rating": 8
    }
  ],
  "remember": ""
}`;

    try {
        if (!(await isOllamaAlive())) throw new Error('Ollama не отвечает. Запустите: ollama serve');
        if (!(await checkModel())) throw new Error(`Модель ${OLLAMA_MODEL} не найдена. Установите: ollama pull ${OLLAMA_MODEL}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const resp = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt: userText,
                system: systemPrompt,
                stream: false,
                options: { temperature: 0.2, num_predict: 1024 }
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return data.response;
    } catch (err) {
        console.error(err);
        return `Ошибка: ${err.message}`;
    }
}

// -------------------------- ОБНОВЛЕНИЕ ПРОФИЛЯ ЧЕЛОВЕКА --------------------------
async function updatePerson(incoming) {
    if (!incoming.name) return;
    if (userProfile.name && incoming.name.toLowerCase() === userProfile.name.toLowerCase()) {
        if (incoming.description && (!userProfile.description || incoming.description.length > userProfile.description.length))
            userProfile.description = incoming.description;
        if (incoming.event && incoming.event.trim().length > 5) {
            const isDup = userProfile.timeline.some(e => e.text === incoming.event);
            if (!isDup) {
                userProfile.timeline.push({ date: Date.now(), text: incoming.event, important: false });
                if (userProfile.timeline.length > 100) userProfile.timeline.shift();
            }
        }
        await saveUser(userProfile);
        return;
    }

    let existing = allPeople.find(p => isSimilarName(p.name, incoming.name));
    if (!existing) {
        existing = {
            id: generateUUID(),
            name: incoming.name,
            description: incoming.description || '',
            timeline: [],
            rating: { value: null, history: [] }
        };
        allPeople.push(existing);
    } else if (incoming.name.length > existing.name.length && incoming.name.toLowerCase().includes(existing.name.toLowerCase())) {
        existing.name = incoming.name;
    }

    if (incoming.description && incoming.description.trim()) existing.description = incoming.description;
    if (incoming.rating && incoming.rating !== '?') {
        let newVal = parseFloat(incoming.rating);
        if (!isNaN(newVal) && newVal >= 0 && newVal <= 10) {
            if (!existing.rating.history) existing.rating.history = [];
            existing.rating.history.push({ value: newVal, timestamp: Date.now(), reason: incoming.event });
            const lastVals = existing.rating.history.slice(-5).map(h => h.value);
            lastVals.sort((a,b)=>a-b);
            existing.rating.value = lastVals[Math.floor(lastVals.length/2)];
        }
    }
    if (incoming.event && incoming.event.trim().length > 5) {
        const isDuplicate = existing.timeline.some(e => e.text === incoming.event);
        if (!isDuplicate) {
            existing.timeline.push({
                date: Date.now(),
                text: incoming.event,
                important: (existing.rating.value !== null && existing.rating.value <= 3)
            });
            if (existing.timeline.length > 100) existing.timeline.shift();
        }
    }
    await savePeople([existing]);
}

// -------------------------- ОТРИСОВКА ПРОФИЛЕЙ --------------------------
async function refreshProfilesUI() {
    allPeople = await loadAllPeople();
    let html = '';

    const userName = userProfile.name || 'Пользователь';
    const userGeneralHtml = userProfile.description ? `<div class="profile-general"><div class="general-label">📌 О ВАС</div><div class="general-text">${escapeHtml(userProfile.description)}</div></div>` : '';
    const userTimelineHtml = userProfile.timeline && userProfile.timeline.length > 0 ? `
        <div class="profile-timeline">
            <div class="timeline-label">📅 МОИ СОБЫТИЯ</div>
            ${userProfile.timeline.slice().reverse().slice(0, 15).map(event => {
                const d = new Date(event.date);
                const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
                return `<div class="timeline-event"><div class="event-date">${dateStr}</div><div class="event-text">${escapeHtml(event.text)}</div></div>`;
            }).join('')}
        </div>
    ` : '';
    html += `<div class="profile-card user-profile"><div class="profile-name">👤 ${escapeHtml(userName)}</div>${userGeneralHtml}${userTimelineHtml}</div>`;

    for (let p of allPeople) {
        const ratingVal = p.rating?.value;
        let ratingText = (ratingVal !== undefined && ratingVal !== null) ? `${ratingVal}/10` : '?/10';
        let ratingClass = 'none';
        if (ratingVal !== null && ratingVal !== undefined) {
            if (ratingVal >= 7) ratingClass = 'good';
            else if (ratingVal <= 3) ratingClass = 'bad';
            else ratingClass = 'neutral';
        }
        const timelineHtml = (p.timeline || []).slice().reverse().slice(0,10).map(e => {
            const d = new Date(e.date);
            const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
            return `<div class="timeline-event ${e.important ? 'important-event' : ''}"><div class="event-date">${dateStr}</div><div class="event-text">${escapeHtml(e.text)}</div></div>`;
        }).join('');
        html += `
            <div class="profile-card" data-id="${p.id}">
                <div class="profile-name">
                    ${escapeHtml(p.name)}
                    <span class="rating-badge ${ratingClass}">${ratingText}</span>
                    <button class="profile-edit-btn" data-id="${p.id}">✏️</button>
                </div>
                ${p.description ? `<div class="profile-general"><div class="general-label">📌 О ПЕРСОНЕ</div><div class="general-text">${escapeHtml(p.description)}</div></div>` : ''}
                <div class="profile-timeline"><div class="timeline-label">📅 ХРОНОЛОГИЯ</div>${timelineHtml || 'Нет событий'}</div>
            </div>
        `;
    }
    if (allPeople.length === 0 && !userProfile.name) html = '<div class="empty-profiles">Нет записей</div>';
    profilesList.innerHTML = html;
    document.querySelectorAll('.profile-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditModal(btn.dataset.id);
        });
    });
}

// -------------------------- ОЧИСТКА ВСЕХ ДАННЫХ --------------------------
async function clearAllHistory() {
    if (!confirm('Удалить всех людей, события и историю чата?')) return;
    localStorage.clear();
    indexedDB.deleteDatabase('CommuniDB');
    setTimeout(() => location.reload(), 200);
}

// -------------------------- ПЕРЕКЛЮЧЕНИЕ (ГЛАВНОЕ) --------------------------
function toggleCollapsible() {
    const collapsible = document.getElementById('collapsibleArea');
    const leftColumn = document.getElementById('leftColumn');
    if (collapsible) {
        collapsible.classList.toggle('hidden');
        if (collapsible.classList.contains('hidden')) {
            leftColumn.classList.add('collapsed');
        } else {
            leftColumn.classList.remove('collapsed');
        }
    }
}

// -------------------------- РЕДАКТИРОВАНИЕ ПРОФИЛЯ --------------------------
let currentEditId = null;
function openEditModal(id) {
    const person = allPeople.find(p => p.id === id);
    if (!person) return;
    currentEditId = id;
    document.getElementById('editName').value = person.name || '';
    document.getElementById('editDesc').value = person.description || '';
    const ratingVal = person.rating?.value;
    document.getElementById('editRating').value = (ratingVal !== undefined && ratingVal !== null) ? ratingVal : '?';
    const eventsText = (person.timeline || []).map(e => {
        const d = new Date(e.date);
        const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
        return `${dateStr}: ${e.text}`;
    }).join('\n');
    document.getElementById('editEvents').value = eventsText;
    document.getElementById('editModal').classList.remove('hidden');
}
document.getElementById('saveProfileBtn')?.addEventListener('click', async () => {
    const person = allPeople.find(p => p.id === currentEditId);
    if (!person) return;
    person.name = document.getElementById('editName').value.trim();
    person.description = document.getElementById('editDesc').value.trim();
    let ratingRaw = document.getElementById('editRating').value.trim();
    let ratingVal = (ratingRaw !== '?' && !isNaN(parseFloat(ratingRaw))) ? parseFloat(ratingRaw) : null;
    person.rating = { value: ratingVal, history: [{ value: ratingVal, timestamp: Date.now(), reason: 'Ручное редактирование' }] };
    const lines = document.getElementById('editEvents').value.split('\n');
    const newTimeline = [];
    for (let line of lines) {
        if (line.trim()) {
            const colonIdx = line.indexOf(':');
            let datePart = colonIdx !== -1 ? line.substring(0, colonIdx).trim() : '';
            let textPart = colonIdx !== -1 ? line.substring(colonIdx+1).trim() : line;
            let timestamp = Date.now();
            if (datePart) {
                const parts = datePart.split('.');
                if (parts.length === 3) {
                    const d = new Date(parts[2], parts[1]-1, parts[0]);
                    if (!isNaN(d.getTime())) timestamp = d.getTime();
                }
            }
            newTimeline.push({ date: timestamp, text: textPart, important: (ratingVal !== null && ratingVal <= 3) });
        }
    }
    person.timeline = newTimeline;
    await savePeople([person]);
    await refreshProfilesUI();
    document.getElementById('editModal').classList.add('hidden');
});
document.querySelector('.close-modal')?.addEventListener('click', () => document.getElementById('editModal').classList.add('hidden'));

// -------------------------- ОБРАБОТКА ВВОДА ПОЛЬЗОВАТЕЛЯ --------------------------
async function handleUserInput(inputText) {
    if (!inputText.trim()) return;
    addMessageToChat(inputText, true);
    await saveChatMessage('user', inputText);

    if (!userProfile.name) {
        const words = inputText.trim().split(/\s+/);
        if (words.length === 1 && !['привет','здравствуй','ку','да','нет'].includes(words[0].toLowerCase())) {
            userProfile.name = words[0];
            await saveUser(userProfile);
            await refreshProfilesUI();
            addMessageToChat(`Приятно познакомиться, ${userProfile.name}! Рассказывай о людях и событиях.`, false);
            await saveChatMessage('assistant', `Приятно познакомиться, ${userProfile.name}! Рассказывай о людях и событиях.`);
            return;
        } else {
            addMessageToChat('Напиши, пожалуйста, своё имя.', false);
            await saveChatMessage('assistant', 'Напиши, пожалуйста, своё имя.');
            return;
        }
    }

    showLoading();
    try {
        const rawAnswer = await askOllama(inputText);
        let replyText = rawAnswer;
        const marker = '###JSON';
        const idx = rawAnswer.indexOf(marker);
        let jsonPart = '';
        if (idx !== -1) {
            replyText = rawAnswer.substring(0, idx).trim();
            jsonPart = rawAnswer.substring(idx + marker.length).trim();
        }
        let jsonData = null;
        try {
            const start = jsonPart.indexOf('{');
            const end = jsonPart.lastIndexOf('}');
            if (start !== -1 && end !== -1) jsonData = JSON.parse(jsonPart.substring(start, end+1));
        } catch(e) {}
        if (jsonData) {
            if (jsonData.remember) await saveFact(jsonData.remember);
            if (jsonData.people) {
                for (let p of jsonData.people) await updatePerson(p);
                await refreshProfilesUI();
            }
        }
        hideLoading();
        addMessageToChat(replyText, false);
        await saveChatMessage('assistant', replyText);
    } catch (err) {
        hideLoading();
        addMessageToChat(`Ошибка: ${err.message}`, false);
    }
}

function addMessageToChat(text, isUser) {
    const div = document.createElement('div');
    div.className = isUser ? 'user-message' : 'ai-message';
    if (!isUser) {
        const avatar = document.createElement('div');
        avatar.className = 'ai-avatar';
        avatar.textContent = '🤖';
        div.appendChild(avatar);
    }
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isUser ? 'user-bubble' : 'ai-bubble'}`;
    bubble.textContent = text;
    div.appendChild(bubble);
    chatMessages.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth' });
}

let loadingDiv = null;
function showLoading() {
    if (loadingDiv) loadingDiv.remove();
    loadingDiv = document.createElement('div');
    loadingDiv.className = 'ai-message';
    loadingDiv.innerHTML = '<div class="ai-avatar">🤖</div><div class="message-bubble ai-bubble">🤔 Думаю...</div>';
    chatMessages.appendChild(loadingDiv);
    loadingDiv.scrollIntoView({ behavior: 'smooth' });
}
function hideLoading() { if (loadingDiv) { loadingDiv.remove(); loadingDiv = null; } }

// -------------------------- ГОЛОСОВОЙ ВВОД --------------------------
function startVoiceInput() {
    if (isListening) { stopVoiceInput(); return; }
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) { voiceStatus.textContent = 'Голосовой ввод не поддерживается'; return; }
    recognition = new SpeechRec();
    recognition.lang = 'ru-RU';
    recognition.interimResults = true;
    recognition.onstart = () => {
        isListening = true;
        voiceBtn.classList.add('listening');
        voiceStatus.textContent = '🎤 Слушаю...';
        textInput.placeholder = '🎙️ Слушаю...';
    };
    recognition.onresult = (event) => {
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; i++)
            if (event.results[i].isFinal) final += event.results[i][0].transcript;
        if (final) {
            textInput.value = final;
            stopVoiceInput();
            setTimeout(() => sendText(), 100);
        } else {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++)
                if (!event.results[i].isFinal) interim += event.results[i][0].transcript;
            if (interim) textInput.value = interim;
        }
    };
    recognition.onerror = () => { voiceStatus.textContent = '❌ Ошибка микрофона'; stopVoiceInput(); };
    recognition.onend = () => stopVoiceInput();
    recognition.start();
}
function stopVoiceInput() {
    if (recognition) try { recognition.stop(); } catch(e) {}
    recognition = null;
    isListening = false;
    voiceBtn.classList.remove('listening');
    voiceStatus.textContent = 'Нажмите для голосового ввода';
    textInput.placeholder = 'Напишите сообщение...';
}
function sendText() {
    const text = textInput.value.trim();
    if (text) { handleUserInput(text); textInput.value = ''; }
}

// -------------------------- ЗАГРУЗКА ИСТОРИИ ЧАТА --------------------------
async function loadChatHistoryUI() {
    const history = await loadChatHistory(50);
    chatMessages.innerHTML = '';
    for (let msg of history) addMessageToChat(msg.content, msg.role === 'user');
}

// -------------------------- ИНИЦИАЛИЗАЦИЯ --------------------------
async function init() {
    await openDB();
    allPeople = await loadAllPeople();
    const savedUser = await loadUser();
    if (savedUser) userProfile = savedUser;
    await refreshProfilesUI();
    await loadChatHistoryUI();

    sendBtn.addEventListener('click', sendText);
    textInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendText(); });
    voiceBtn.addEventListener('click', startVoiceInput);
    document.getElementById('clearAllDataBtn')?.addEventListener('click', clearAllHistory);
    document.getElementById('toggleBtn')?.addEventListener('click', toggleCollapsible);
    window.addEventListener('click', (e) => { if (e.target === document.getElementById('editModal')) document.getElementById('editModal').classList.add('hidden'); });

    if (!userProfile.name) addMessageToChat('Привет! Как тебя зовут? Напиши своё имя.', false);
    else addMessageToChat(`С возвращением, ${userProfile.name}! Чем могу помочь?`, false);
}

init();