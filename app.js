// ============================================
// app.js — Тренажёр + доступ к сайтам
// ============================================

// ============================================
// БАЗОВЫЙ URL
// ============================================
const BASE_URL = (() => {
    if (window.AndroidBridge?.getBaseUrl) {
        const b = window.AndroidBridge.getBaseUrl();
        if (b) { const c = b.replace(/\/+$/, ''); localStorage.setItem('appBaseUrl', c); return c; }
    }
    const q = new URLSearchParams(location.search).get('base');
    if (q) { const c = q.replace(/\/+$/, ''); localStorage.setItem('appBaseUrl', c); return c; }
    if (location.hostname.endsWith('github.io')) {
        const parts = location.pathname.split('/').filter(Boolean);
        if (parts.length) { const a = `${location.origin}/${parts[0]}`; localStorage.setItem('appBaseUrl', a); return a; }
    }
    const s = localStorage.getItem('appBaseUrl');
    return s ? s.replace(/\/+$/, '') : location.origin;
})();

const url = (p) => {
    if (/^https?:\/\//i.test(p)) return p; // уже абсолютный
    return `${BASE_URL}/${p.replace(/^\/+/, '')}`;
};

// ============================================
// СОСТОЯНИЕ
// ============================================
const state = {
    currentTest: null,
    userAnswers: {},
    serverOffset: 0,
    serverSynced: false,
    lastPosition: null,
    lastPositionPromise: null,
    sessionUnlocked: new Set(),
    activeSiteId: null,
    activeSiteStartedAt: 0
};

const now = () => Date.now() + state.serverOffset;

// Доверяем сохранённому смещению не дольше 6 часов
const TIME_TRUST_MAX_AGE = 6 * 60 * 60 * 1000;

// Последний успешный источник времени
let lastTimeSource = null;

// ============================================
// DOM-хелперы
// ============================================
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function escapeHtml(t) {
    return String(t ?? '').replace(/[&<>"']/g,
        m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[m]));
}

function formatTime(ms) {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}ч ${m}м`;
    if (m > 0) return `${m}м ${s}с`;
    return `${s}с`;
}

function formatMinutes(ms) {
    return Math.round(ms / 60000);
}

async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ============================================
// ТОСТЫ
// ============================================
function toast(message, type = 'info', duration = 4000) {
    const root = $('#toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => {
        el.classList.add('hiding');
        setTimeout(() => el.remove(), 250);
    }, duration);
}

// ============================================
// МОДАЛКИ
// ============================================
function openModal(html, onMount) {
    const root = $('#modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card">${html}</div>`;
    root.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay); });
    if (onMount) onMount(overlay);
    return overlay;
}

function closeModal(overlay) {
    if (!overlay) {
        const o = $('#modal-root .modal-overlay');
        if (o) o.remove();
        return;
    }
    overlay.remove();
}

// ============================================
// ГЕОПОЗИЦИЯ
// ============================================
function getCurrentPosition(force = false) {
    const cacheMs = window.CONFIG?.geolocation?.cachePositionMs ?? 30000;
    if (!force && state.lastPosition && (Date.now() - state.lastPosition.timestamp < cacheMs)) {
        return Promise.resolve(state.lastPosition);
    }
    if (state.lastPositionPromise && !force) return state.lastPositionPromise;

    const cfg = window.CONFIG?.geolocation || {};
    const opts = {
        enableHighAccuracy: cfg.enableHighAccuracy ?? true,
        timeout: cfg.timeoutMs ?? 10000,
        maximumAge: cfg.maximumAge ?? 60000
    };

    state.lastPositionPromise = new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            state.lastPositionPromise = null;
            return reject(new Error('Геолокация не поддерживается'));
        }
        navigator.geolocation.getCurrentPosition(
            pos => {
                state.lastPosition = {
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    timestamp: Date.now()
                };
                state.lastPositionPromise = null;
                resolve(state.lastPosition);
            },
            err => {
                state.lastPositionPromise = null;
                const msgs = { 1: 'Доступ к геолокации запрещён', 2: 'Позиция недоступна', 3: 'Превышено время GPS' };
                reject(new Error(msgs[err.code] || 'Ошибка геолокации'));
            },
            opts
        );
    });
    return state.lastPositionPromise;
}

// ============================================
// ПРОВЕРКИ: ГЕОЗОНА
// ============================================
function checkGeofence(site, position) {
    const gf = site.geofence;
    if (!gf) return { ok: true, kind: 'none' };
    if (!position) return { ok: false, reason: 'Нет данных о геопозиции' };
    const d = haversineMeters(position.lat, position.lon, gf.lat, gf.lon);
    if (d <= gf.radiusMeters) return { ok: true, distance: d, kind: 'ok' };
    return {
        ok: false,
        distance: d,
        reason: `Вы в ${Math.round(d)} м от «${gf.label}» (макс. ${gf.radiusMeters} м)`
    };
}

// ============================================
// ПРОВЕРКИ: РАСПИСАНИЕ
// ============================================
function checkSchedule(site) {
    const sc = site.schedule;
    if (!sc) return { ok: true, kind: 'none' };
    const date = new Date(now());
    const tz = sc.timezone || 'Asia/Krasnoyarsk';
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const curDay = dayMap[dayFmt.format(date)];
    const timeFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const curTime = timeFmt.format(date);
    const [ch, cm] = curTime.split(':').map(Number);
    const [fh, fm] = sc.from.split(':').map(Number);
    const [th, tm] = sc.to.split(':').map(Number);
    const curMin = ch * 60 + cm, fromMin = fh * 60 + fm, toMin = th * 60 + tm;
    const dayOk = Array.isArray(sc.days) && sc.days.includes(curDay);
    let timeOk;
    if (fromMin <= toMin) timeOk = curMin >= fromMin && curMin <= toMin;
    else timeOk = curMin >= fromMin || curMin <= toMin;
    const dayNames = ['вс','пн','вт','ср','чт','пт','сб'];
    if (dayOk && timeOk) return { ok: true, kind: 'ok' };
    return {
        ok: false,
        reason: `Доступ: ${sc.days.map(d => dayNames[d]).join(', ')} в ${sc.from}–${sc.to} (${tz}). Сейчас: ${curTime}, ${dayNames[curDay]}`
    };
}

// ============================================
// ПРОВЕРКИ: ИНТЕРВАЛЬНЫЙ ДОСТУП
// ============================================
function checkIntervalAccess(site) {
    const ia = site.intervalAccess;
    if (!ia || !ia.enabled) {
        return { ok: true, kind: 'none' };
    }

    const intervalMs = ia.intervalMs;
    const windowMs = ia.windowMs;

    if (!intervalMs || !windowMs || intervalMs <= 0 || windowMs <= 0) {
        return { ok: true, kind: 'invalid' };
    }
    if (windowMs >= intervalMs) {
        return { ok: true, kind: 'always' };
    }

    const anchorMs = ia.anchorAt ? Date.parse(ia.anchorAt) : 0;
    if (!isFinite(anchorMs)) {
        return { ok: true, kind: 'invalid' };
    }

    const nowMs = now();
    const elapsed = nowMs - anchorMs;

    if (elapsed < 0) {
        return {
            ok: false,
            kind: 'before-start',
            reason: `Интервальный доступ начнётся с ${ia.anchorAt}`
        };
    }

    const positionInCycle = elapsed % intervalMs;
    const inWindow = positionInCycle < windowMs;

    if (inWindow) {
        const leftMs = windowMs - positionInCycle;
        return {
            ok: true,
            kind: 'open',
            leftMs,
            positionInCycle,
            intervalMs,
            windowMs
        };
    }

    const nextWindowMs = intervalMs - positionInCycle;
    return {
        ok: false,
        kind: 'closed',
        nextWindowMs,
        intervalMs,
        windowMs,
        reason: `Следующее окно через ${formatTime(nextWindowMs)}`
    };
}

// ============================================
// ДОВЕРИЕ ВРЕМЕНИ
// ============================================
function isTimeTrusted() {
    if (state.serverSynced) return true;
    const savedAt = parseInt(localStorage.getItem('serverSyncAt') || '0', 10);
    if (!savedAt) return false;
    return Date.now() - savedAt < TIME_TRUST_MAX_AGE;
}

// ============================================
// IndexedDB — второй слой для счётчиков
// ============================================
const IDB_NAME = 'trenerUsage';
const IDB_STORE = 'usage';

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) {
                req.result.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    try {
        const db = await idbOpen();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function idbSet(key, value) {
    try {
        const db = await idbOpen();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch { return false; }
}

async function idbClear() {
    try {
        const db = await idbOpen();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch { return false; }
}

// ============================================
// ЛИМИТ ВРЕМЕНИ
// ============================================
function todayKey() {
    const d = new Date(now());
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const usageKey = (id) => `usage:${id}:${todayKey()}`;

function getUsedMsSync(id) {
    return parseInt(localStorage.getItem(usageKey(id)) || '0', 10);
}

async function getUsedMs(id) {
    const ls = getUsedMsSync(id);
    const idb = parseInt((await idbGet(usageKey(id))) || 0, 10);
    return Math.max(ls, idb);
}

async function setUsedMs(id, ms) {
    const value = Math.max(0, ms);
    localStorage.setItem(usageKey(id), String(value));
    await idbSet(usageKey(id), value);
}

async function addUsedMs(id, ms) {
    const current = await getUsedMs(id);
    const newValue = current + ms;
    await setUsedMs(id, newValue);
    return newValue;
}

// Точная проверка лимита (async)
async function checkDailyLimit(site) {
    if (!isTimeTrusted()) {
        return {
            ok: false, used: 0, limit: site.limitMs || 0, left: 0, percent: 0,
            timeError: true,
            reason: 'Время не синхронизировано. Проверьте интернет.'
        };
    }
    const limit = site.limitMs || 0;
    if (limit <= 0) return { ok: true, used: 0, limit: 0, left: 0, percent: 0 };
    const used = await getUsedMs(site.id);
    const left = Math.max(0, limit - used);
    const percent = Math.min(100, (used / limit) * 100);
    if (used >= limit) return {
        ok: false, used, limit, left: 0, percent: 100,
        reason: `Лимит исчерпан (${formatMinutes(used)}/${formatMinutes(limit)} мин)`
    };
    return { ok: true, used, limit, left, percent };
}

// ============================================
// ТЕСТЫ
// ============================================
function isTestPassed(id) {
    if (window.AndroidBridge?.isTestPassed) {
        try { return !!window.AndroidBridge.isTestPassed(id); } catch {}
    }
    return localStorage.getItem(`test-passed:${id}`) === '1';
}
function markTestPassed(id) { localStorage.setItem(`test-passed:${id}`, '1'); }
function unmarkTestPassed(id) { localStorage.removeItem(`test-passed:${id}`); }

function checkRequiredTests(site) {
    const req = site.requiredTestIds || [];
    if (!req.length) return { ok: true, passed: 0, total: 0 };
    const passed = req.filter(isTestPassed).length;
    if (passed === req.length) return { ok: true, passed, total: req.length };
    const missing = req.filter(id => !isTestPassed(id));
    const names = missing.map(id => window.TEST_REGISTRY.find(t => t.id === id)?.title || id);
    return {
        ok: false, passed, total: req.length, missing,
        reason: `Пройдено ${passed}/${req.length}. Не хватает: ${names.join(', ')}`
    };
}

// ============================================
// ПАРОЛИ
// ============================================
const pwdAttemptsKey = (id) => `pwd-attempts:${id}`;
const pwdBlockKey    = (id) => `pwd-block-until:${id}`;

function getAttempts(id) { return parseInt(localStorage.getItem(pwdAttemptsKey(id)) || '0', 10); }
function setAttempts(id, n) { localStorage.setItem(pwdAttemptsKey(id), String(n)); }
function resetAttempts(id) { localStorage.removeItem(pwdAttemptsKey(id)); }

function isBlocked(id) {
    const until = parseInt(localStorage.getItem(pwdBlockKey(id)) || '0', 10);
    if (!until) return { blocked: false };
    const left = until - now();
    if (left <= 0) { localStorage.removeItem(pwdBlockKey(id)); resetAttempts(id); return { blocked: false }; }
    return { blocked: true, leftMs: left };
}
function blockSite(id, ms) { localStorage.setItem(pwdBlockKey(id), String(now() + ms)); }

async function checkPassword(site, input) {
    const p = site.password;
    if (!p?.enabled) return { ok: true, target: site.url, isDecoy: false };
    const hash = await sha256(input);
    if (hash === p.realHash) { resetAttempts(site.id); return { ok: true, target: site.url, isDecoy: false }; }
    if (p.duressHash && hash === p.duressHash) {
        return { ok: true, target: p.decoyUrl || 'https://example.com', decoyName: p.decoyName || 'Example.com', isDecoy: true };
    }
    const attempts = getAttempts(site.id) + 1;
    setAttempts(site.id, attempts);
    if (p.maxAttempts && attempts >= p.maxAttempts) {
        blockSite(site.id, p.blockDurationMs || 1800000);
        return {
            ok: false, fatal: true,
            reason: `Слишком много попыток. Блокировка ${formatMinutes(p.blockDurationMs || 1800000)} мин.`
        };
    }
    return { ok: false, reason: `Неверный пароль. Осталось: ${(p.maxAttempts || 3) - attempts}` };
}

function askPassword(site, verifyFn) {
    return new Promise(resolve => {
        const p = site.password || {};
        const maxAttempts = p.maxAttempts || 3;

        const overlay = openModal(`
            <div class="modal-header">
                <div class="modal-icon">${site.icon || '🔒'}</div>
                <div>
                    <h3 class="modal-title">${escapeHtml(site.name)}</h3>
                    <p class="modal-subtitle">Требуется пароль</p>
                </div>
            </div>
            <div class="modal-body">
                <input type="password" class="modal-input" id="pwd-input"
                       autocomplete="off" inputmode="text" placeholder="••••••••" autofocus>
                ${p.hint ? `<p class="modal-hint">💡 ${escapeHtml(p.hint)}</p>` : ''}
                <div class="modal-attempts" id="pwd-dots"></div>
                <p class="modal-error" id="pwd-error"></p>
            </div>
            <div class="modal-actions">
                <button class="modal-btn-secondary" id="pwd-cancel">Отмена</button>
                <button class="modal-btn-primary" id="pwd-submit">Открыть</button>
            </div>
        `);

        const input = overlay.querySelector('#pwd-input');
        const errEl = overlay.querySelector('#pwd-error');
        const dotsEl = overlay.querySelector('#pwd-dots');

        function renderDots() {
            const used = getAttempts(site.id);
            dotsEl.innerHTML = Array.from({ length: maxAttempts }, (_, i) =>
                `<span class="attempt-dot ${i < used ? 'used' : ''}"></span>`
            ).join('');
        }
        renderDots();

        let busy = false;
        async function trySubmit() {
            if (busy) return;
            busy = true;
            const value = input.value;
            if (!value) { errEl.textContent = 'Введите пароль'; busy = false; return; }

            const result = await verifyFn(value);
            if (result.ok) { closeModal(overlay); resolve(result); return; }

            errEl.textContent = result.reason || 'Неверный пароль';
            input.value = '';
            input.focus();
            renderDots();
            busy = false;
            if (result.fatal) { closeModal(overlay); resolve(null); }
        }

        overlay.querySelector('#pwd-submit').onclick = trySubmit;
        overlay.querySelector('#pwd-cancel').onclick = () => { closeModal(overlay); resolve(null); };
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') trySubmit();
            if (e.key === 'Escape') { closeModal(overlay); resolve(null); }
        });

        setTimeout(() => input.focus(), 100);
    });
}

async function requestPassword(site) {
    const p = site.password;
    const blk = isBlocked(site.id);
    if (blk.blocked) {
        toast(`🔒 Заблокировано. Осталось ${formatMinutes(blk.leftMs)} мин.`, 'error');
        return null;
    }
    if (p.mode === 'requireOnce' && state.sessionUnlocked.has(site.id)) {
        return { url: site.url, isDecoy: false };
    }

    return await askPassword(site, async (input) => {
        const r = await checkPassword(site, input);
        if (r.ok) {
            if (!r.isDecoy && p.mode === 'requireOnce') state.sessionUnlocked.add(site.id);
            return r;
        }
        const nowBlk = isBlocked(site.id);
        if (nowBlk.blocked) return { ok: false, reason: r.reason, fatal: true };
        return r;
    });
}

// ============================================
// ЗАГРУЗКА ДАННЫХ
// ============================================
async function fetchJson(path) {
    const res = await fetch(url(path), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
}

async function loadConfig() {
    try { const c = await fetchJson('config.json'); window.setConfig(c); return c; }
    catch (e) { console.error('config.json:', e); return null; }
}
async function loadSites() {
    try {
        const f = window.CONFIG?.access?.sitesFile || 'access/sites.json';
        const d = await fetchJson(f);
        window.setSitesConfig(d);
        return d;
    } catch (e) { console.error('sites.json:', e); return null; }
}
async function loadGeopoints() {
    try {
        const f = window.CONFIG?.access?.geopointsFile || 'access/geopoints.json';
        const d = await fetchJson(f);
        window.setGeopoints(d.geopoints || []);
    } catch { window.setGeopoints([]); }
}
async function loadSchedules() {
    try {
        const f = window.CONFIG?.access?.schedulesFile || 'access/schedules.json';
        const d = await fetchJson(f);
        window.setSchedules(d.schedules || []);
    } catch { window.setSchedules([]); }
}
async function loadTestSets() {
    try {
        const f = window.CONFIG?.access?.testSetsFile || 'access/test-sets.json';
        const d = await fetchJson(f);
        window.setTestSets(d.testSets || []);
    } catch { window.setTestSets([]); }
}
async function loadAllTests() {
    try {
        const f = window.CONFIG?.tests?.indexFile || 'tests/index.json';
        const idx = await fetchJson(f);
        if (!Array.isArray(idx.tests)) throw new Error('нет tests');
        const loaded = await Promise.all(idx.tests.map(async e => {
            try { return await fetchJson(e.file); } catch { return null; }
        }));
        window.setTestRegistry(loaded.filter(Boolean));
    } catch { window.setTestRegistry([]); }
}

function resolveRefs() {
    (window.SITES_CONFIG?.sites || []).forEach(site => {
        if (typeof site.geofence === 'string') {
            const g = window.GEOPOINTS.find(x => x.id === site.geofence);
            site.geofence = g ? { ...g } : null;
        }
        if (typeof site.schedule === 'string') {
            const s = window.SCHEDULES.find(x => x.id === site.schedule);
            site.schedule = s ? { ...s } : null;
        }
    });
}

// ============================================
// СИНХРОНИЗАЦИЯ ВРЕМЕНИ
// ============================================
async function syncTime() {
    const providers = window.CONFIG?.timeSource?.providers || [];

    for (const p of providers) {
        try {
            const res = await fetch(url(p.url), { cache: 'no-store' });
            if (!res.ok) continue;
            const json = await res.json();

            let serverMs;

            if (p.parse === 'date' || p.parse === 'iso') {
                const raw = p.path ? p.path.split('.').reduce((a, k) => a?.[k], json) : json;
                if (raw == null) continue;
                serverMs = Date.parse(raw);
            } else {
                const raw = p.path.split('.').reduce((a, k) => a?.[k], json);
                if (raw == null) continue;
                serverMs = raw * (p.multiplier || 1);
            }

            if (!isFinite(serverMs) || serverMs <= 0) continue;

            state.serverOffset = serverMs - Date.now();
            state.serverSynced = true;
            lastTimeSource = p.name;

            localStorage.setItem('serverOffset', String(state.serverOffset));
            localStorage.setItem('serverSyncAt', String(Date.now()));
            localStorage.setItem('serverSource', p.name);

            updateTimeStatus(true, p.name);
            return true;
        } catch (e) {
            console.warn(`⚠️ ${p.name}:`, e.message);
        }
    }

    // Фолбэк: последнее сохранённое смещение
    const saved = localStorage.getItem('serverOffset');
    const savedAt = parseInt(localStorage.getItem('serverSyncAt') || '0', 10);
    const savedSource = localStorage.getItem('serverSource') || 'кэш';

    if (saved && Date.now() - savedAt < TIME_TRUST_MAX_AGE) {
        state.serverOffset = parseInt(saved, 10);
        state.serverSynced = false;
        lastTimeSource = savedSource;
        updateTimeStatus(false);
        console.warn('⚠️ Время из кэша:', new Date(now()).toISOString());
        return false;
    }

    state.serverOffset = 0;
    state.serverSynced = false;
    lastTimeSource = null;
    updateTimeStatus(false);
    console.warn('⚠️ Время НЕ синхронизировано');
    return false;
}

function updateTimeStatus(ok, source) {
    const el = $('#time-status');
    if (!el) return;

    if (ok) {
        const drift = Math.round(state.serverOffset / 1000);
        el.className = 'time-status ok';
        el.textContent = `⏱ ${drift >= 0 ? '+' : ''}${drift}с`;
        el.title = `Источник: ${source}`;
    } else if (isTimeTrusted()) {
        const drift = Math.round(state.serverOffset / 1000);
        el.className = 'time-status ok';
        el.textContent = `⏱ ${drift >= 0 ? '+' : ''}${drift}с`;
        el.title = `Источник: кэш (${lastTimeSource || '—'})`;
    } else {
        el.className = 'time-status error';
        el.textContent = '⚠ время';
        el.title = 'Нет синхронизации времени';
    }
}

// ============================================
// РЕНДЕР: ТЕМЫ
// ============================================
function renderTopics() {
    const containers = {
        html: $('#html-topics'),
        css:  $('#css-topics'),
        js:   $('#js-topics')
    };
    Object.values(containers).forEach(c => { if (c) c.innerHTML = ''; });

    const counts = { html: 0, css: 0, js: 0 };

    window.TEST_REGISTRY.forEach(test => {
        const cont = containers[test.category];
        if (!cont) return;
        counts[test.category]++;

        const passed = isTestPassed(test.id);
        const usedFor = getSitesUsingTest(test.id);

        const btn = document.createElement('button');
        btn.className = 'topic-btn' + (passed ? ' passed' : '');
        btn.innerHTML = `
            <span class="topic-name">${escapeHtml(test.title)}</span>
            ${usedFor.length ? `<span class="topic-used-for">→ нужно для: ${usedFor.map(s => escapeHtml(s.name)).join(', ')}</span>` : ''}
        `;
        btn.addEventListener('click', () => startTest(test.id));
        cont.appendChild(btn);
    });

    $('#html-count').textContent = `${counts.html}`;
    $('#css-count').textContent  = `${counts.css}`;
    $('#js-count').textContent   = `${counts.js}`;
}

function getSitesUsingTest(testId) {
    return (window.SITES_CONFIG?.sites || []).filter(s =>
        (s.requiredTestIds || []).includes(testId)
    );
}

function initAccordion() {
    $$('.category-header').forEach(h => {
        h.addEventListener('click', () => {
            const list = document.getElementById(h.dataset.target);
            const section = h.closest('.category-section');
            section.classList.toggle('open');
            list.classList.toggle('collapsed');
        });
    });
}

// ============================================
// РЕНДЕР: САЙТЫ
// ============================================
async function renderSites() {
    const list = $('#sites-list');
    const cfg = window.SITES_CONFIG;
    if (!cfg?.sites?.length) {
        list.innerHTML = '<div class="summary-empty">Нет доступных сайтов</div>';
        return;
    }

    list.innerHTML = '';

    let pos = null;
    const hasGeo = cfg.sites.some(s => s.geofence);
    if (hasGeo) {
        try { pos = await getCurrentPosition(); } catch {}
    }

    for (const site of cfg.sites) {
        const card = await buildSiteCard(site, pos);
        list.appendChild(card);
    }

    updateGeoStatus(pos);
}

async function buildSiteCard(site, pos) {
    const card = document.createElement('div');
    card.className = 'site-card';

    const lim = await checkDailyLimit(site);
    const sch = checkSchedule(site);
    const geo = site.geofence ? checkGeofence(site, pos) : { ok: true, kind: 'none' };
    const tests = checkRequiredTests(site);
    const ia = site.intervalAccess?.enabled ? checkIntervalAccess(site) : { ok: true, kind: 'none' };
    const hasPwd = site.password?.enabled;

    const allOk = lim.ok && sch.ok && geo.ok && tests.ok && ia.ok;

    const chips = [];

    if (lim.timeError) {
        chips.push(`<span class="status-chip error">⚠ время</span>`);
    }

    if (lim.limit > 0) {
        const used = formatMinutes(lim.used);
        const tot = formatMinutes(lim.limit);
        let chipClass = 'ok';
        if (lim.percent >= 100) chipClass = 'error';
        else if (lim.percent >= 80) chipClass = 'warn';
        chips.push(`<span class="status-chip ${chipClass}">⏱ ${used}/${tot} мин</span>`);
    }

    if (site.schedule) {
        chips.push(`<span class="status-chip ${sch.ok ? 'ok' : 'error'}">🕐 ${sch.ok ? 'Открыто' : 'Закрыто'}</span>`);
    }

    if (site.intervalAccess?.enabled) {
        if (ia.ok && ia.kind === 'open') {
            chips.push(`<span class="status-chip ok">⏳ Окно: ${formatTime(ia.leftMs)}</span>`);
        } else if (ia.kind === 'closed') {
            chips.push(`<span class="status-chip warn">⏳ Через ${formatTime(ia.nextWindowMs)}</span>`);
        } else if (ia.kind === 'before-start') {
            chips.push(`<span class="status-chip warn">⏳ Скоро</span>`);
        } else {
            chips.push(`<span class="status-chip error">⏳ Закрыто</span>`);
        }
    }

    if (site.geofence) {
        if (geo.ok && geo.distance != null) {
            chips.push(`<span class="status-chip ok">📍 ${Math.round(geo.distance)} м</span>`);
        } else if (geo.ok) {
            chips.push(`<span class="status-chip info">📍 ${escapeHtml(site.geofence.label)}</span>`);
        } else {
            chips.push(`<span class="status-chip error">📍 Далеко</span>`);
        }
    }

    if (tests.total > 0) {
        chips.push(`<span class="status-chip ${tests.ok ? 'ok' : 'error'}">📚 ${tests.passed}/${tests.total}</span>`);
    }

    if (hasPwd) {
        chips.push(`<span class="status-chip info">🔒 Пароль</span>`);
    }

    const barClass = lim.percent >= 100 ? 'over' : lim.percent >= 80 ? 'warn' : '';
    const barHtml = lim.limit > 0
        ? `<div class="limit-bar"><div class="limit-bar-fill ${barClass}" style="width:${lim.percent}%"></div></div>`
        : '';

    card.innerHTML = `
        <div class="site-header">
            <div class="site-icon">${site.icon || '🌐'}</div>
            <div class="site-info">
                <div class="site-name">${escapeHtml(site.name)}</div>
                <div class="site-url">${escapeHtml(site.url)}</div>
            </div>
        </div>
        <div class="site-status">${chips.join('')}</div>
        ${barHtml}
        <div class="site-actions">
            <button class="site-open-btn" ${allOk ? '' : 'disabled'}>${allOk ? '▶ Открыть' : '🚫 Недоступно'}</button>
            <button class="site-details-btn">ℹ️</button>
        </div>
    `;

    card.querySelector('.site-details-btn').addEventListener('click', () => showSiteDetails(site, pos));
    if (allOk) {
        card.querySelector('.site-open-btn').addEventListener('click', () => tryOpenSite(site));
    }

    if (allOk) card.classList.add('ready');
    else card.classList.add('locked');

    return card;
}

function updateGeoStatus(pos) {
    const el = $('#geo-status');
    if (!el) return;
    const hasGeo = (window.SITES_CONFIG?.sites || []).some(s => s.geofence);
    if (!hasGeo) { el.textContent = ''; el.className = 'geo-status'; return; }

    if (pos) {
        el.textContent = `📍 ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)} (±${Math.round(pos.accuracy)} м)`;
        el.className = 'geo-status ok';
    } else {
        el.textContent = '⚠️ Геолокация недоступна';
        el.className = 'geo-status error';
    }
}

// ============================================
// ДЕТАЛИ САЙТА
// ============================================
async function showSiteDetails(site, pos) {
    const lim = await checkDailyLimit(site);
    const sch = checkSchedule(site);
    const geo = site.geofence ? checkGeofence(site, pos) : null;
    const tests = checkRequiredTests(site);
    const hasPwd = site.password?.enabled;

    const rows = [];
    rows.push(`<div class="modal-info-row"><span>URL</span><strong>${escapeHtml(site.url)}</strong></div>`);

    if (lim.timeError) {
        rows.push(`<div class="modal-info-row"><span>Время</span><strong class="error">Не синхронизировано</strong></div>`);
    }

    if (lim.limit > 0) {
        rows.push(`<div class="modal-info-row"><span>Лимит</span><strong>${formatMinutes(lim.used)} / ${formatMinutes(lim.limit)} мин</strong></div>`);
        rows.push(`<div class="modal-info-row"><span>Осталось</span><strong class="${lim.left > 0 ? 'ok' : 'error'}">${formatMinutes(lim.left)} мин</strong></div>`);
    }

    if (site.schedule) {
        const dayNames = ['вс','пн','вт','ср','чт','пт','сб'];
        rows.push(`<div class="modal-info-row"><span>Расписание</span><strong class="${sch.ok ? 'ok' : 'error'}">${site.schedule.days.map(d => dayNames[d]).join(', ')} ${site.schedule.from}–${site.schedule.to}</strong></div>`);
    }

    if (site.intervalAccess?.enabled) {
        const ia = site.intervalAccess;
        const check = checkIntervalAccess(site);
        const intervalMin = Math.round(ia.intervalMs / 60000);
        const windowMin = Math.round(ia.windowMs / 60000);
        rows.push(`<div class="modal-info-row">
            <span>Интервальный доступ</span>
            <strong>${windowMin} мин каждые ${intervalMin} мин</strong>
        </div>`);
        if (check.ok && check.kind === 'open') {
            rows.push(`<div class="modal-info-row"><span>Статус</span><strong class="ok">Открыто · осталось ${formatTime(check.leftMs)}</strong></div>`);
        } else if (check.kind === 'closed') {
            rows.push(`<div class="modal-info-row"><span>Статус</span><strong class="warn">Следующее окно через ${formatTime(check.nextWindowMs)}</strong></div>`);
        } else if (check.kind === 'before-start') {
            rows.push(`<div class="modal-info-row"><span>Статус</span><strong class="warn">${escapeHtml(check.reason || 'Скоро')}</strong></div>`);
        }
    }

    if (site.geofence) {
        rows.push(`<div class="modal-info-row"><span>Геоточка</span><strong class="${geo?.ok ? 'ok' : 'error'}">${escapeHtml(site.geofence.label)}</strong></div>`);
        if (geo?.distance != null) {
            rows.push(`<div class="modal-info-row"><span>Расстояние</span><strong>${Math.round(geo.distance)} м (макс. ${site.geofence.radiusMeters} м)</strong></div>`);
        }
    }

    if (tests.total > 0) {
        rows.push(`<div class="modal-info-row"><span>Тесты</span><strong class="${tests.ok ? 'ok' : 'error'}">${tests.passed}/${tests.total} пройдено</strong></div>`);
    }

    if (hasPwd) {
        const mode = site.password.mode === 'requireOnce' ? 'Один раз за сессию' : 'Каждый раз';
        rows.push(`<div class="modal-info-row"><span>Пароль</span><strong>🔒 ${mode}</strong></div>`);
    }

    openModal(`
        <div class="modal-header">
            <div class="modal-icon">${site.icon || '🌐'}</div>
            <div>
                <h3 class="modal-title">${escapeHtml(site.name)}</h3>
                <p class="modal-subtitle">${escapeHtml(site.url)}</p>
            </div>
        </div>
        <div class="modal-body">
            ${rows.join('')}
        </div>
        <div class="modal-actions">
            <button class="modal-btn-secondary" id="d-close">Закрыть</button>
            <button class="modal-btn-primary" id="d-open">▶ Открыть</button>
        </div>
    `, (overlay) => {
        overlay.querySelector('#d-close').onclick = () => closeModal(overlay);
        overlay.querySelector('#d-open').onclick = () => { closeModal(overlay); tryOpenSite(site); };
    });
}

// ============================================
// ОТКРЫТИЕ САЙТА
// ============================================
async function tryOpenSite(site) {
    // 1. Время
    if (!isTimeTrusted()) {
        toast('⚠ Время не синхронизировано. Подключите интернет.', 'error', 6000);
        return;
    }

    // 2. Дневной лимит
    const lim = await checkDailyLimit(site);
    if (!lim.ok) { toast(`⏱ ${lim.reason}`, 'error', 6000); return; }

    // 3. Расписание
    const sch = checkSchedule(site);
    if (!sch.ok) { toast(`🕐 ${sch.reason}`, 'warn', 6000); return; }

    // 4. Интервальный доступ
    const ia = checkIntervalAccess(site);
    if (!ia.ok) {
        const msg = ia.kind === 'closed'
            ? `⏳ Следующее окно через ${formatTime(ia.nextWindowMs)}`
            : `⏳ ${ia.reason || 'Закрыто'}`;
        toast(msg, 'warn', 6000);
        return;
    }

    // 5. Геоточка
    if (site.geofence) {
        try {
            const pos = await getCurrentPosition(true);
            const geo = checkGeofence(site, pos);
            if (!geo.ok) { toast(`📍 ${geo.reason}`, 'error', 6000); return; }
        } catch (e) { toast(`📍 Геолокация: ${e.message}`, 'error'); return; }
    }

    // 6. Тесты
    const tests = checkRequiredTests(site);
    if (!tests.ok) { toast(`📚 ${tests.reason}`, 'warn', 6000); return; }

    // 7. Пароль
    if (site.password?.enabled) {
        const pwdResult = await requestPassword(site);
        if (!pwdResult) return;

        if (pwdResult.isDecoy) {
            openSiteContent({ ...site, url: pwdResult.url, name: pwdResult.decoyName, _isDecoy: true });
            return;
        }
    }

    openSiteContent(site);
}

function openSiteContent(site) {
    if (site._isDecoy) {
        if (window.AndroidBridge?.openSite) {
            window.AndroidBridge.openSite(site.url, 'decoy', site.limitMs || 600000);
            return;
        }
        window.open(site.url, '_blank');
        return;
    }

    if (window.AndroidBridge?.openSite) {
        window.AndroidBridge.openSite(site.url, site.id, site.limitMs);
        trackUsage(site);
        toast(`✅ Открыто: ${site.name}`, 'success');
        return;
    }

    const win = window.open(site.url, '_blank');
    if (!win) { toast('Разрешите всплывающие окна', 'error'); return; }

    trackUsage(site);
    toast(`✅ Открыто: ${site.name}. Через ${formatMinutes(site.limitMs)} мин закроется.`, 'success', 5000);

    setTimeout(() => { try { win.close(); } catch {} }, site.limitMs);
}

function trackUsage(site) {
    const started = Date.now();
    const planned = site.limitMs;

    state.activeSiteId = site.id;
    state.activeSiteStartedAt = started;

    const commit = async () => {
        const elapsed = Math.min(Date.now() - started, planned);
        await addUsedMs(site.id, elapsed);
        state.activeSiteId = null;
    };

    window.addEventListener('beforeunload', commit, { once: true });

    const tick = setInterval(() => {
        const elapsed = Date.now() - started;
        if (elapsed >= planned) {
            clearInterval(tick);
            commit();
            window.removeEventListener('beforeunload', commit);
        }
    }, 1000);
}

// ============================================
// СВОДКА
// ============================================
async function renderSummary() {
    const list = $('#summary-list');
    const dateEl = $('#summary-date');
    const sites = window.SITES_CONFIG?.sites || [];

    const d = new Date(now());
    const days = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];

    const trustBadge = isTimeTrusted()
        ? `<span class="status-chip ok" style="font-size:0.72rem;margin-left:8px">✓ время</span>`
        : `<span class="status-chip error" style="font-size:0.72rem;margin-left:8px">⚠ время</span>`;

    dateEl.innerHTML = `${days[d.getDay()]}, ${d.toLocaleDateString('ru-RU')}${trustBadge}`;

    const items = [];
    for (const s of sites) {
        const used = await getUsedMs(s.id);
        if (used > 0) items.push({ site: s, used, limit: s.limitMs || 0 });
    }
    items.sort((a, b) => b.used - a.used);

    if (!items.length) {
        list.innerHTML = '<div class="summary-empty">Сегодня ещё ничего не открывалось</div>';
        return;
    }

    const totalUsed = items.reduce((sum, x) => sum + x.used, 0);
    const totalHtml = `
        <div class="summary-total">
            <span class="summary-total-label">Всего сегодня</span>
            <span class="summary-total-value">${formatTime(totalUsed)}</span>
        </div>
    `;

    const itemsHtml = items.map(({ site, used, limit }) => {
        const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const over = limit > 0 && used >= limit;
        const limitText = limit > 0 ? `${formatMinutes(used)} / ${formatMinutes(limit)} мин` : formatTime(used);
        return `
            <div class="summary-item">
                <div class="summary-icon">${site.icon || '🌐'}</div>
                <div class="summary-body">
                    <div class="summary-name">${escapeHtml(site.name)}</div>
                    <div class="summary-stats">
                        <span>${limitText}</span>
                        <span>${formatTime(used)}</span>
                    </div>
                    <div class="summary-bar">
                        <div class="summary-bar-fill ${over ? 'over' : ''}" style="width:${percent}%"></div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    list.innerHTML = totalHtml + itemsHtml;
}

// ============================================
// ТЕСТ
// ============================================
function startTest(testId) {
    const test = window.TEST_REGISTRY.find(t => t.id === testId);
    if (!test) return;

    state.currentTest = {
        ...test,
        questions: shuffleArray(test.questions).map(shuffleOptions)
    };
    state.userAnswers = {};

    $$('.screen').forEach(s => s.classList.remove('active'));
    $('#screen-quiz').classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    $('#quiz-title').textContent = test.title;
    $('#test-description').textContent = test.description;

    $('#check-btn').style.display = 'inline-block';
    $('#check-btn').disabled = false;
    $('#reset-btn').style.display = 'none';
    $('#result-container').classList.add('hidden');
    $('#score-display').innerHTML = '';
    $('#detailed-results').innerHTML = '';

    renderQuiz();
}

function shuffleArray(a) {
    a = [...a];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function shuffleOptions(q) {
    const withMeta = q.options.map((text, i) => ({ text, isCorrect: q.correct.includes(i) }));
    const sh = shuffleArray(withMeta);
    const newCorrect = [];
    sh.forEach((o, i) => { if (o.isCorrect) newCorrect.push(i); });
    return { ...q, options: sh.map(o => o.text), correct: newCorrect };
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

function renderQuiz() {
    let html = '';
    state.currentTest.questions.forEach((q, index) => {
        html += `<div class="question-card" data-qid="${q.id}">`;
        html += `<h3>Вопрос ${index + 1}: ${escapeHtml(q.question)}</h3>`;
        if (q.type === 'multiple') html += `<p class="hint">Выберите несколько вариантов</p>`;
        q.options.forEach((opt, i) => {
            const type = q.type === 'multiple' ? 'checkbox' : 'radio';
            html += `<label class="option-label">
                <input type="${type}" name="q${q.id}" value="${i}" data-qid="${q.id}">
                <span>${escapeHtml(opt)}</span>
            </label>`;
        });
        html += `</div>`;
    });
    $('#quiz-container').innerHTML = html;
    $('#quiz-container').addEventListener('change', handleAnswerChange);
}

function handleAnswerChange(e) {
    const qid = parseInt(e.target.dataset.qid);
    if (!state.userAnswers[qid]) state.userAnswers[qid] = [];
    const q = state.currentTest.questions.find(x => x.id === qid);
    if (q.type === 'single') {
        state.userAnswers[qid] = [parseInt(e.target.value)];
    } else {
        const v = parseInt(e.target.value);
        if (e.target.checked) {
            if (!state.userAnswers[qid].includes(v)) state.userAnswers[qid].push(v);
        } else {
            state.userAnswers[qid] = state.userAnswers[qid].filter(x => x !== v);
        }
    }
}

function checkAnswers() {
    let score = 0;
    const total = state.currentTest.questions.length;
    let detailsHtml = '';

    state.currentTest.questions.forEach((q, index) => {
        const ua = state.userAnswers[q.id] || [];
        const correct = arraysEqual([...ua].sort(), [...q.correct].sort());
        if (correct) score++;

        const card = document.querySelector(`.question-card[data-qid="${q.id}"]`);
        card.querySelectorAll('.option-label').forEach((label, i) => {
            const input = label.querySelector('input');
            label.classList.remove('correct', 'incorrect');
            if (q.correct.includes(i)) label.classList.add('correct');
            else if (ua.includes(i)) label.classList.add('incorrect');
            input.disabled = true;
        });

        detailsHtml += `<div class="result-item ${correct ? 'success' : 'fail'}">
            <p><strong>Вопрос ${index + 1}:</strong> ${correct ? '✅ Верно' : '❌ Неверно'}</p>
            <p class="explanation">💡 ${escapeHtml(q.explanation)}</p>
        </div>`;
    });

    $('#score-display').innerHTML = `Вы набрали <span>${score}</span> из <span>${total}</span>`;
    $('#detailed-results').innerHTML = detailsHtml;
    $('#result-container').classList.remove('hidden');

    $('#check-btn').style.display = 'none';
    $('#reset-btn').style.display = 'inline-block';
    $('#reset-btn').scrollIntoView({ behavior: 'smooth' });

    if (score === total) {
        markTestPassed(state.currentTest.id);
        toast(`🎉 Тест пройден! ${state.currentTest.title}`, 'success', 5000);
    } else {
        toast(`Набрано ${score}/${total}. Попробуйте ещё раз.`, 'info');
    }
}

function resetQuiz() {
    if (!state.currentTest) return;
    startTest(state.currentTest.id);
}

function goBack() {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $('#screen-topics').classList.add('active');
    state.currentTest = null;
    state.userAnswers = {};
    renderTopics();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================
// НАСТРОЙКИ
// ============================================
function renderSettings() {
    $('#diag-base').textContent = BASE_URL;
    $('#diag-offset').textContent = `${Math.round(state.serverOffset / 1000)}с`;
    $('#diag-now').textContent = new Date(now()).toLocaleString('ru-RU');
    $('#diag-time-trust').textContent = isTimeTrusted() ? '✓ доверенное' : '⚠ нет';
    $('#diag-time-source').textContent = lastTimeSource || (state.serverSynced ? '—' : 'кэш');
    $('#diag-geo').textContent = state.lastPosition
        ? `${state.lastPosition.lat.toFixed(4)}, ${state.lastPosition.lon.toFixed(4)}`
        : 'нет';
    $('#diag-tests').textContent = window.TEST_REGISTRY.length;
    $('#diag-sites').textContent = (window.SITES_CONFIG?.sites || []).length;

    const listEl = $('#mark-tests-list');
    listEl.innerHTML = '';
    window.TEST_REGISTRY.forEach(test => {
        const passed = isTestPassed(test.id);
        const row = document.createElement('div');
        row.className = 'mark-test-row';
        row.innerHTML = `
            <input type="checkbox" id="mt-${test.id}" ${passed ? 'checked' : ''}>
            <label for="mt-${test.id}">${escapeHtml(test.title)} <span style="color:var(--dim)">[${test.category}]</span></label>
        `;
        row.querySelector('input').addEventListener('change', e => {
            if (e.target.checked) markTestPassed(test.id);
            else unmarkTestPassed(test.id);
            renderTopics();
        });
        listEl.appendChild(row);
    });
}

// ============================================
// НАВИГАЦИЯ
// ============================================
function switchScreen(name) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    $(`#screen-${name}`).classList.add('active');
    $(`.nav-tab[data-screen="${name}"]`).classList.add('active');

    if (name === 'sites') renderSites();
    if (name === 'summary') renderSummary();
    if (name === 'settings') renderSettings();
    if (name === 'topics') renderTopics();

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================
// СЛУШАТЕЛИ
// ============================================
$$('.nav-tab').forEach(t => t.addEventListener('click', () => switchScreen(t.dataset.screen)));
$('#check-btn').addEventListener('click', checkAnswers);
$('#reset-btn').addEventListener('click', resetQuiz);
$('#back-btn').addEventListener('click', goBack);

$('#reset-tests-btn').addEventListener('click', () => {
    if (!confirm('Сбросить все отметки тестов?')) return;
    window.TEST_REGISTRY.forEach(t => unmarkTestPassed(t.id));
    toast('Отметки тестов сброшены', 'success');
    renderSettings();
    renderTopics();
});

$('#reset-all-btn').addEventListener('click', async () => {
    if (!confirm('Полный сброс? Будут удалены все счётчики, отметки тестов и попытки паролей.\n\nЭто действие необратимо.')) return;
    localStorage.clear();
    await idbClear();
    location.reload();
});

$('#debug-reset-usage').addEventListener('click', async () => {
    const sites = window.SITES_CONFIG?.sites || [];
    if (!confirm(`Сбросить счётчики времени для ${sites.length} сайтов?\n\nЭто действие только для отладки.`)) return;
    for (const s of sites) {
        await setUsedMs(s.id, 0);
    }
    toast('Счётчики сброшены (отладка)', 'warn');
    renderSettings();
    if ($('#screen-summary').classList.contains('active')) renderSummary();
});

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================
(async function init() {
    console.log('🚀 Старт');

    const cfg = await loadConfig();
    await syncTime();

    await Promise.all([
        loadSites(),
        loadGeopoints(),
        loadSchedules(),
        loadTestSets(),
        loadAllTests()
    ]);

    resolveRefs();

    renderTopics();
    initAccordion();

    window.addEventListener('beforeunload', async () => {
        if (state.activeSiteId) {
            const elapsed = Date.now() - state.activeSiteStartedAt;
            await addUsedMs(state.activeSiteId, elapsed);
        }
    });

    setInterval(syncTime, cfg?.timeSource?.resyncIntervalMs || 60000);

    setInterval(() => {
        if ($('#screen-summary')?.classList.contains('active')) renderSummary();
    }, 5000);

    setInterval(() => {
        if ($('#screen-sites')?.classList.contains('active')) renderSites();
    }, 15000);

    console.log('✅ Готово. Время:', state.serverSynced ? 'синхронизировано' : (isTimeTrusted() ? 'кэш' : 'нет'));
})();