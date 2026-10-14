// ============================================
// editor.js — редактор правил доступа
// + защита по расписанию (editor-policy.json)
// + интервальный доступ (intervalAccess)
// Часовой пояс по умолчанию: Asia/Krasnoyarsk
// ============================================

// ---------- Состояние ----------
const STATE = {
    sites:      [],
    geopoints:  [],
    schedules:  [],
    testSets:   [],
    testIndex:  []
};

const STORAGE_KEY = 'accessEditorState';

// Часовой пояс по умолчанию
const DEFAULT_TZ = 'Asia/Krasnoyarsk';

// ---------- Утилиты ----------
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(t) {
    return String(t ?? '').replace(/[&<>"']/g,
        m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function toast(msg, type = 'info', duration = 3500) {
    const root = $('#toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
        el.classList.add('hiding');
        setTimeout(() => el.remove(), 250);
    }, duration);
}

function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE)); }
    catch (e) { console.warn('saveState:', e); }
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        Object.assign(STATE, JSON.parse(raw));
    } catch (e) { console.warn('loadState:', e); }
}

// Преобразование локального времени в ISO с учётом смещения
function localToIso(localStr) {
    if (!localStr) return null;
    // localStr вида "2026-01-01T00:00"
    const d = new Date(localStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

// ============================================
// ЗАЩИТА РЕДАКТОРА ПО РАСПИСАНИЮ
// ============================================

const EDITOR_POLICY_URL = '../access/editor-policy.json';
const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

let editorServerOffset = 0;
let editorTimeSynced = false;
let editorPolicyCache = null;

const editorNow = () => Date.now() + editorServerOffset;

// --- Синхронизация времени ---
async function editorSyncTime() {
    const providers = [
        { name: 'Coinbase',     url: 'https://api.coinbase.com/v2/time', path: 'data.epoch', multiplier: 1000 },
        { name: 'WorldTimeAPI', url: 'https://worldtimeapi.org/api/ip',  path: 'unixtime',   multiplier: 1000 }
    ];

    for (const p of providers) {
        try {
            const res = await fetch(p.url, { cache: 'no-store' });
            if (!res.ok) continue;
            const json = await res.json();
            const raw = p.path.split('.').reduce((a, k) => a?.[k], json);
            if (raw == null) continue;

            const ms = raw * p.multiplier;
            if (!isFinite(ms) || ms <= 0) continue;

            editorServerOffset = ms - Date.now();
            editorTimeSynced = true;
            localStorage.setItem('editorServerOffset', String(editorServerOffset));
            localStorage.setItem('editorSyncAt', String(Date.now()));
            return true;
        } catch { /* следующий провайдер */ }
    }

    // Фолбэк — последнее сохранённое смещение (не старше 1 часа)
    const saved = localStorage.getItem('editorServerOffset');
    const savedAt = parseInt(localStorage.getItem('editorSyncAt') || '0', 10);
    const MAX_AGE = 60 * 60 * 1000; // 1 час
    if (saved && Date.now() - savedAt < MAX_AGE) {
        editorServerOffset = parseInt(saved, 10);
        editorTimeSynced = false;
        return false;
    }

    editorServerOffset = 0;
    editorTimeSynced = false;
    return false;
}

// --- Проверка расписания ---
function editorCheckSchedule(policy) {
    if (!policy?.enabled) return { ok: true };

    const sc = policy.schedule;
    if (!sc) return { ok: true };

    const date = new Date(editorNow());
    const tz = sc.timezone || DEFAULT_TZ;

    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const curDay = dayMap[dayFmt.format(date)];

    const timeFmt = new Intl.DateTimeFormat('ru-RU', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    });
    const curTime = timeFmt.format(date);

    const [ch, cm] = curTime.split(':').map(Number);
    const [fh, fm] = sc.from.split(':').map(Number);
    const [th, tm] = sc.to.split(':').map(Number);

    const curMin  = ch * 60 + cm;
    const fromMin = fh * 60 + fm;
    const toMin   = th * 60 + tm;

    const dayOk = Array.isArray(sc.days) && sc.days.includes(curDay);

    let timeOk;
    if (fromMin <= toMin) {
        timeOk = curMin >= fromMin && curMin <= toMin;
    } else {
        // ночной интервал (например 22:00–06:00)
        timeOk = curMin >= fromMin || curMin <= toMin;
    }

    if (dayOk && timeOk) {
        return { ok: true, curDay, curTime, tz };
    }

    return {
        ok: false,
        curDay,
        curTime,
        tz,
        reason: `${sc.days.map(d => DAY_NAMES[d]).join(', ')} в ${sc.from}–${sc.to} (${tz})`
    };
}

// --- Загрузка политики ---
async function loadEditorPolicy() {
    if (editorPolicyCache) return editorPolicyCache;
    try {
        const res = await fetch(EDITOR_POLICY_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        editorPolicyCache = data.editorPolicy || { enabled: false };
    } catch (e) {
        console.warn('editor-policy.json не загружен:', e.message);
        editorPolicyCache = { enabled: false };
    }
    return editorPolicyCache;
}

// --- Показать экран блокировки ---
function showLockScreen(policy, scheduleResult) {
    $('#editor-root')?.classList.add('hidden');

    const lock = $('#lock-screen');
    if (!lock) return;
    lock.classList.remove('hidden');

    const msgEl = $('#lock-message');
    if (msgEl && policy.blockMessage) msgEl.textContent = policy.blockMessage;

    const det = $('#lock-details');
    if (det) {
        const rows = [];

        if (scheduleResult) {
            rows.push(`<div class="row"><span>Разрешено</span><span>${escapeHtml(scheduleResult.reason)}</span></div>`);
            rows.push(`<div class="row error"><span>Сейчас</span><span>${escapeHtml(scheduleResult.curTime)}, ${DAY_NAMES[scheduleResult.curDay]}</span></div>`);
        }

        rows.push(`<div class="row ${editorTimeSynced ? 'ok' : 'error'}">
            <span>Время</span>
            <span>${editorTimeSynced ? '✓ синхронизировано' : '⚠ не синхронизировано'}</span>
        </div>`);

        if (policy.requireTimeSync && !editorTimeSynced) {
            rows.push(`<div class="row error"><span>Причина</span><span>Не удалось получить серверное время</span></div>`);
        }

        det.innerHTML = rows.join('');
    }

    // Кнопка переопределения паролем
    const overrideEl = $('#lock-override');
    if (policy.allowPasswordOverride && policy.overrideHash && overrideEl) {
        overrideEl.classList.remove('hidden');

        const submit = $('#lock-submit');
        const input = $('#lock-password');
        const errEl = $('#lock-error');

        const tryOverride = async () => {
            const pwd = input.value;
            if (!pwd) { errEl.textContent = 'Введите пароль'; return; }
            const hash = await sha256(pwd);
            if (hash === policy.overrideHash) {
                lock.classList.add('hidden');
                $('#editor-root')?.classList.remove('hidden');
                toast('Редактор разблокирован', 'success');
            } else {
                errEl.textContent = 'Неверный пароль';
                input.value = '';
                input.focus();
            }
        };

        submit.onclick = tryOverride;
        input.onkeydown = (e) => { if (e.key === 'Enter') tryOverride(); };
    } else if (overrideEl) {
        overrideEl.classList.add('hidden');
    }
}

// --- Показать редактор ---
function showEditor() {
    $('#lock-screen')?.classList.add('hidden');
    $('#editor-root')?.classList.remove('hidden');
}

// --- Главная проверка ---
async function checkEditorAccess() {
    await editorSyncTime();

    const policy = await loadEditorPolicy();

    if (!policy.enabled) {
        showEditor();
        return true;
    }

    if (policy.requireTimeSync && !editorTimeSynced) {
        showLockScreen(policy, null);
        return false;
    }

    const sch = editorCheckSchedule(policy);
    if (!sch.ok) {
        showLockScreen(policy, sch);
        return false;
    }

    showEditor();
    return true;
}

// --- Автопериодическая проверка ---
setInterval(async () => {
    const editorRoot = $('#editor-root');
    if (!editorRoot || editorRoot.classList.contains('hidden')) return;

    const policy = editorPolicyCache || await loadEditorPolicy();
    if (!policy?.enabled) return;

    const sch = editorCheckSchedule(policy);
    if (!sch.ok) {
        showLockScreen(policy, sch);
        toast('Время доступа к редактору истекло', 'warn');
    }
}, 30000);

// ============================================
// РЕНДЕР
// ============================================
function renderAll() {
    renderSites();
    renderGeopoints();
    renderSchedules();
    renderTestSets();
    renderTests();
    renderPasswordTab();
}

// ========== САЙТЫ ==========
function renderSites() {
    const root = $('#tab-sites');
    root.innerHTML = `
        <div class="panel-toolbar">
            <button class="btn btn-primary" id="add-site">+ Добавить сайт</button>
            <span class="spacer"></span>
            <span class="counter">${STATE.sites.length} сайтов</span>
        </div>
        <div class="list" id="sites-list"></div>
    `;
    $('#add-site').onclick = () => openSiteForm(null);

    const listEl = $('#sites-list');
    if (!STATE.sites.length) {
        listEl.innerHTML = '<div class="empty">Пока нет сайтов. Нажмите «Добавить сайт».</div>';
        return;
    }

    STATE.sites.forEach((site, idx) => {
        const geo = resolveGeo(site.geofence);
        const sch = resolveSchedule(site.schedule);
        const pwd = site.password;
        const ia = site.intervalAccess;

        const tests = (site.requiredTestIds || []).map(id => {
            const t = STATE.testIndex.find(x => x.id === id);
            return `<span class="badge badge-test">📚 ${escapeHtml(t ? t.title : id)}</span>`;
        }).join('');

        const iaBadge = (ia?.enabled)
            ? `<span class="badge badge-interval">⏳ ${Math.round(ia.windowMs / 60000)}/${Math.round(ia.intervalMs / 60000)} мин</span>`
            : '';

        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
            <div class="item-body">
                <div class="item-title">${escapeHtml(site.icon || '🌐')} ${escapeHtml(site.name)}</div>
                <div class="item-sub">${escapeHtml(site.url)}</div>
                <div class="item-badges">
                    <span class="badge">⏱ ${Math.round((site.limitMs || 0) / 60000)} мин</span>
                    ${geo ? `<span class="badge badge-geo">📍 ${escapeHtml(geo.label)}</span>` : ''}
                    ${sch ? `<span class="badge badge-sched">🕐 ${escapeHtml(sch.label)}</span>` : ''}
                    ${iaBadge}
                    ${pwd?.enabled ? `<span class="badge badge-pwd">🔒 пароль</span>` : ''}
                    ${tests}
                </div>
            </div>
            <div class="item-actions">
                <button class="btn btn-secondary btn-small" data-edit="${idx}">✏️</button>
                <button class="btn btn-secondary btn-small" data-dup="${idx}">📋</button>
                <button class="btn btn-danger btn-small" data-del="${idx}">🗑</button>
            </div>
        `;
        listEl.appendChild(el);
    });

    $$('[data-edit]', listEl).forEach(b => b.onclick = () => openSiteForm(+b.dataset.edit));
    $$('[data-dup]', listEl).forEach(b => b.onclick = () => {
        const copy = JSON.parse(JSON.stringify(STATE.sites[+b.dataset.dup]));
        copy.id = uid('site');
        copy.name = copy.name + ' (копия)';
        STATE.sites.push(copy);
        saveState(); renderSites();
        toast('Сайт скопирован', 'success');
    });
    $$('[data-del]', listEl).forEach(b => b.onclick = () => {
        if (confirm(`Удалить сайт «${STATE.sites[+b.dataset.del].name}»?`)) {
            STATE.sites.splice(+b.dataset.del, 1);
            saveState(); renderAll();
            toast('Сайт удалён', 'success');
        }
    });
}

// ========== ГЕОТОЧКИ ==========
function renderGeopoints() {
    const root = $('#tab-geopoints');
    root.innerHTML = `
        <div class="panel-toolbar">
            <button class="btn btn-primary" id="add-geo">+ Добавить геоточку</button>
            <span class="spacer"></span>
            <span class="counter">${STATE.geopoints.length} геоточек</span>
        </div>
        <div class="list" id="geo-list"></div>
    `;
    $('#add-geo').onclick = () => openGeoForm(null);

    const listEl = $('#geo-list');
    if (!STATE.geopoints.length) {
        listEl.innerHTML = '<div class="empty">Пока нет геоточек.</div>';
        return;
    }
    STATE.geopoints.forEach((g, idx) => {
        const usedIn = STATE.sites.filter(s => s.geofence === g.id).length;
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
            <div class="item-body">
                <div class="item-title">📍 ${escapeHtml(g.label)}</div>
                <div class="item-sub">
                    id: <span class="code-cell">${escapeHtml(g.id)}</span>
                </div>
                <div class="item-badges">
                    <span class="badge">${g.lat}, ${g.lon}</span>
                    <span class="badge">R = ${g.radiusMeters} м</span>
                    ${usedIn ? `<span class="badge badge-ok">используется в ${usedIn} сайтах</span>` : '<span class="badge badge-warn">не используется</span>'}
                </div>
            </div>
            <div class="item-actions">
                <button class="btn btn-secondary btn-small" data-edit="${idx}">✏️</button>
                <button class="btn btn-danger btn-small" data-del="${idx}">🗑</button>
            </div>
        `;
        listEl.appendChild(el);
    });
    $$('[data-edit]', listEl).forEach(b => b.onclick = () => openGeoForm(+b.dataset.edit));
    $$('[data-del]', listEl).forEach(b => b.onclick = () => {
        const g = STATE.geopoints[+b.dataset.del];
        const usedIn = STATE.sites.filter(s => s.geofence === g.id).length;
        if (usedIn) {
            if (!confirm(`Геоточка используется в ${usedIn} сайтах. Удалить? У этих сайтов геозона станет пустой.`)) return;
        } else {
            if (!confirm('Удалить геоточку?')) return;
        }
        STATE.geopoints.splice(+b.dataset.del, 1);
        saveState(); renderAll();
        toast('Геоточка удалена', 'success');
    });
}

// ========== РАСПИСАНИЯ ==========
function renderSchedules() {
    const root = $('#tab-schedules');
    root.innerHTML = `
        <div class="panel-toolbar">
            <button class="btn btn-primary" id="add-sch">+ Добавить расписание</button>
            <span class="spacer"></span>
            <span class="counter">${STATE.schedules.length} расписаний</span>
        </div>
        <div class="list" id="sch-list"></div>
    `;
    $('#add-sch').onclick = () => openScheduleForm(null);

    const listEl = $('#sch-list');
    if (!STATE.schedules.length) {
        listEl.innerHTML = '<div class="empty">Пока нет расписаний.</div>';
        return;
    }
    STATE.schedules.forEach((s, idx) => {
        const days = (s.days || []).map(d => DAY_NAMES[d]).join(', ');
        const usedIn = STATE.sites.filter(x => x.schedule === s.id).length;
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
            <div class="item-body">
                <div class="item-title">🕐 ${escapeHtml(s.label)}</div>
                <div class="item-sub">id: <span class="code-cell">${escapeHtml(s.id)}</span></div>
                <div class="item-badges">
                    <span class="badge badge-sched">${days}</span>
                    <span class="badge">${s.from}–${s.to}</span>
                    <span class="badge">${escapeHtml(s.timezone)}</span>
                    ${usedIn ? `<span class="badge badge-ok">в ${usedIn} сайтах</span>` : '<span class="badge badge-warn">не используется</span>'}
                </div>
            </div>
            <div class="item-actions">
                <button class="btn btn-secondary btn-small" data-edit="${idx}">✏️</button>
                <button class="btn btn-danger btn-small" data-del="${idx}">🗑</button>
            </div>
        `;
        listEl.appendChild(el);
    });
    $$('[data-edit]', listEl).forEach(b => b.onclick = () => openScheduleForm(+b.dataset.edit));
    $$('[data-del]', listEl).forEach(b => b.onclick = () => {
        const s = STATE.schedules[+b.dataset.del];
        const usedIn = STATE.sites.filter(x => x.schedule === s.id).length;
        if (usedIn) {
            if (!confirm(`Расписание используется в ${usedIn} сайтах. Удалить?`)) return;
        }
        STATE.schedules.splice(+b.dataset.del, 1);
        saveState(); renderAll();
        toast('Расписание удалено', 'success');
    });
}

// ========== НАБОРЫ ТЕСТОВ ==========
function renderTestSets() {
    const root = $('#tab-testsets');
    root.innerHTML = `
        <div class="panel-toolbar">
            <button class="btn btn-primary" id="add-ts">+ Добавить набор</button>
            <span class="spacer"></span>
            <span class="counter">${STATE.testSets.length} наборов</span>
        </div>
        <div class="list" id="ts-list"></div>
    `;
    $('#add-ts').onclick = () => openTestSetForm(null);

    const listEl = $('#ts-list');
    if (!STATE.testSets.length) {
        listEl.innerHTML = '<div class="empty">Пока нет наборов тестов.</div>';
        return;
    }
    STATE.testSets.forEach((ts, idx) => {
        const chips = (ts.testIds || []).map(id => {
            const t = STATE.testIndex.find(x => x.id === id);
            return `<span class="badge badge-test">${escapeHtml(t ? t.title : id)}</span>`;
        }).join('');
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
            <div class="item-body">
                <div class="item-title">📋 ${escapeHtml(ts.label)}</div>
                <div class="item-sub">id: <span class="code-cell">${escapeHtml(ts.id)}</span></div>
                <div class="item-badges">${chips || '<span class="badge badge-warn">пусто</span>'}</div>
            </div>
            <div class="item-actions">
                <button class="btn btn-secondary btn-small" data-edit="${idx}">✏️</button>
                <button class="btn btn-danger btn-small" data-del="${idx}">🗑</button>
            </div>
        `;
        listEl.appendChild(el);
    });
    $$('[data-edit]', listEl).forEach(b => b.onclick = () => openTestSetForm(+b.dataset.edit));
    $$('[data-del]', listEl).forEach(b => b.onclick = () => {
        if (confirm('Удалить набор?')) {
            STATE.testSets.splice(+b.dataset.del, 1);
            saveState(); renderAll();
            toast('Набор удалён', 'success');
        }
    });
}

// ========== ТЕСТЫ (только просмотр) ==========
function renderTests() {
    const root = $('#tab-tests');
    root.innerHTML = `
        <div class="panel-toolbar">
            <button class="btn btn-secondary" id="reload-tests">🔄 Обновить из tests/index.json</button>
            <span class="spacer"></span>
            <span class="counter">${STATE.testIndex.length} тестов</span>
        </div>
        <p class="hint" style="margin-bottom:16px">
            Список тестов загружается из <span class="code-cell">tests/index.json</span>.
            Чтобы добавить тест — отредактируйте этот файл и нажмите «Обновить».
        </p>
        <div class="list" id="tests-list"></div>
    `;
    $('#reload-tests').onclick = async () => {
        await tryLoadTestIndex(true);
        renderAll();
        toast('Список тестов обновлён', 'success');
    };

    const listEl = $('#tests-list');
    if (!STATE.testIndex.length) {
        listEl.innerHTML = '<div class="empty">Нет загруженных тестов. Проверьте tests/index.json.</div>';
        return;
    }

    const byCat = { html: [], css: [], js: [], other: [] };
    STATE.testIndex.forEach(t => {
        const cat = ['html','css','js'].includes(t.category) ? t.category : 'other';
        byCat[cat].push(t);
    });

    const catNames = { html: '📄 HTML', css: '🎨 CSS', js: '⚡ JavaScript', other: '📦 Прочее' };

    Object.entries(byCat).forEach(([cat, tests]) => {
        if (!tests.length) return;
        const catEl = document.createElement('div');
        catEl.innerHTML = `<h3 style="font-size:0.95rem;color:#fff;margin:16px 0 8px">${catNames[cat]} (${tests.length})</h3>`;
        const inner = document.createElement('div');
        inner.className = 'list';

        tests.forEach(t => {
            const usedIn = STATE.sites.filter(s => (s.requiredTestIds || []).includes(t.id)).length;
            const item = document.createElement('div');
            item.className = 'item';
            item.innerHTML = `
                <div class="item-body">
                    <div class="item-title">${escapeHtml(t.title)}</div>
                    <div class="item-sub">id: <span class="code-cell">${escapeHtml(t.id)}</span></div>
                    <div class="item-badges">
                        ${usedIn
                            ? `<span class="badge badge-ok">нужен для ${usedIn} сайтов</span>`
                            : '<span class="badge badge-warn">не используется</span>'}
                    </div>
                </div>
            `;
            inner.appendChild(item);
        });
        catEl.appendChild(inner);
        listEl.appendChild(catEl);
    });
}

// ========== ПАРОЛИ (общий список) ==========
function renderPasswordTab() {
    const root = $('#tab-password');
    const sitesWithPwd = STATE.sites.filter(s => s.password?.enabled);

    root.innerHTML = `
        <div class="panel-toolbar">
            <span class="counter">🔒 ${sitesWithPwd.length} сайтов с паролем</span>
        </div>
        <div class="field-section" style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:16px">
            <h3 class="field-section-title">🔑 Генератор SHA-256 хеша</h3>
            <p class="hint">Введите пароль — получите хеш. Вставляйте его в поле realHash или duressHash в форме сайта.</p>
            <div class="field-row">
                <div class="field">
                    <label>Пароль</label>
                    <input id="hash-input" type="text" placeholder="мой-пароль">
                </div>
                <div class="field">
                    <label>SHA-256</label>
                    <input id="hash-output" type="text" readonly placeholder="появится здесь">
                </div>
            </div>
            <button class="btn btn-secondary" id="hash-copy" style="margin-top:8px">📋 Скопировать хеш</button>
        </div>
        <div class="list" id="pwd-list"></div>
    `;

    const hashIn = $('#hash-input');
    const hashOut = $('#hash-output');
    let hashTimeout;
    hashIn.addEventListener('input', () => {
        clearTimeout(hashTimeout);
        hashTimeout = setTimeout(async () => {
            if (!hashIn.value) { hashOut.value = ''; return; }
            hashOut.value = await sha256(hashIn.value);
        }, 300);
    });
    $('#hash-copy').onclick = () => {
        if (!hashOut.value) return toast('Сначала введите пароль', 'warn');
        navigator.clipboard.writeText(hashOut.value);
        toast('Хеш скопирован', 'success');
    };

    const listEl = $('#pwd-list');
    if (!sitesWithPwd.length) {
        listEl.innerHTML = '<div class="empty">Ни у одного сайта нет пароля.<br>Откройте вкладку «Сайты» и включите пароль.</div>';
        return;
    }

    sitesWithPwd.forEach(site => {
        const p = site.password;
        const mode = p.mode === 'requireOnce' ? 'Один раз за сессию' : 'Каждый раз';
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
            <div class="item-body">
                <div class="item-title">${escapeHtml(site.icon || '🌐')} ${escapeHtml(site.name)}</div>
                <div class="item-sub">${escapeHtml(site.url)}</div>
                <div class="item-badges">
                    <span class="badge badge-pwd">🔒 ${mode}</span>
                    <span class="badge">Макс. попыток: ${p.maxAttempts || 3}</span>
                    <span class="badge">Блок: ${Math.round((p.blockDurationMs || 1800000) / 60000)} мин</span>
                </div>
                <div style="margin-top:8px;font-size:0.78rem;color:var(--muted)">
                    <div>realHash: <span class="code-cell">${p.realHash ? p.realHash.slice(0, 16) + '…' : '—'}</span></div>
                    <div>duressHash: <span class="code-cell">${p.duressHash ? p.duressHash.slice(0, 16) + '…' : '—'}</span></div>
                    <div>decoy: <span class="code-cell">${escapeHtml(p.decoyUrl || '—')}</span></div>
                </div>
            </div>
            <div class="item-actions">
                <button class="btn btn-secondary btn-small" data-edit-site="${STATE.sites.indexOf(site)}">✏️</button>
            </div>
        `;
        listEl.appendChild(el);
    });

    $$('[data-edit-site]', listEl).forEach(b => b.onclick = () => {
        openSiteForm(+b.dataset.editSite);
    });
}

// ---------- Резолверы ----------
function resolveGeo(ref) {
    if (!ref) return null;
    if (typeof ref === 'string') return STATE.geopoints.find(g => g.id === ref) || null;
    return ref;
}
function resolveSchedule(ref) {
    if (!ref) return null;
    if (typeof ref === 'string') return STATE.schedules.find(s => s.id === ref) || null;
    return ref;
}

// ---------- Модалка ----------
const modal      = $('#modal');
const modalForm  = $('#modal-form');
const modalTitle = $('#modal-title');

function openModal(title, formHtml, onSubmit) {
    modalTitle.textContent = title;
    modalForm.innerHTML = formHtml;
    modal.classList.remove('hidden');
    modalForm.onsubmit = (e) => { e.preventDefault(); onSubmit(); };
}

function closeModal() {
    modal.classList.add('hidden');
    modalForm.innerHTML = '';
}

$('#modal-close').onclick = closeModal;
modal.onclick = (e) => { if (e.target === modal) closeModal(); };

// ---------- ФОРМА САЙТА ----------
function openSiteForm(index) {
    const isNew = index === null;
    const s = isNew ? {
        id: uid('site'), url: '', name: '', icon: '🌐',
        limitMs: 300000, requiredTestIds: [],
        geofence: null, schedule: null,
        intervalAccess: null,
        password: null
    } : JSON.parse(JSON.stringify(STATE.sites[index]));

    const geoOptions = ['<option value="">— нет —</option>']
        .concat(STATE.geopoints.map(g =>
            `<option value="${g.id}" ${s.geofence === g.id ? 'selected' : ''}>${escapeHtml(g.label)}</option>`))
        .join('');
    const schOptions = ['<option value="">— нет —</option>']
        .concat(STATE.schedules.map(sc =>
            `<option value="${sc.id}" ${s.schedule === sc.id ? 'selected' : ''}>${escapeHtml(sc.label)}</option>`))
        .join('');

    const testCheckboxes = STATE.testIndex.map(t => `
        <label class="test-list-item">
            <input type="checkbox" value="${t.id}" ${s.requiredTestIds?.includes(t.id) ? 'checked' : ''}>
            <span>${escapeHtml(t.title)} <span style="color:var(--dim)">[${t.category}]</span></span>
        </label>`).join('');

    const pwd = s.password || {};
    const ia = s.intervalAccess || {};

    // Значение для datetime-local в ISO формате без времени
    const iaAnchorValue = ia.anchorAt
        ? new Date(ia.anchorAt).toISOString().slice(0, 16)
        : '';

    openModal(isNew ? 'Новый сайт' : 'Редактирование сайта', `
        <div class="field"><label>ID</label><input id="f-id" value="${escapeHtml(s.id)}" required></div>
        <div class="field"><label>URL</label><input id="f-url" value="${escapeHtml(s.url)}" required placeholder="https://..."></div>
        <div class="field-row">
            <div class="field"><label>Название</label><input id="f-name" value="${escapeHtml(s.name)}" required></div>
            <div class="field"><label>Иконка (эмодзи)</label><input id="f-icon" value="${escapeHtml(s.icon)}" maxlength="4"></div>
        </div>
        <div class="field">
            <label>Лимит в день (минуты)</label>
            <input id="f-limit" type="number" min="1" value="${Math.round((s.limitMs || 0) / 60000)}" required>
        </div>
        <div class="field-row">
            <div class="field"><label>Геоточка</label><select id="f-geo">${geoOptions}</select></div>
            <div class="field"><label>Расписание</label><select id="f-sch">${schOptions}</select></div>
        </div>
        <div class="field">
            <label>Обязательные тесты</label>
            <div class="test-list">
                ${testCheckboxes || '<span style="color:var(--dim);font-size:0.85rem">Нет загруженных тестов</span>'}
            </div>
        </div>

        <!-- ======== ИНТЕРВАЛЬНЫЙ ДОСТУП ======== -->
        <div class="field-section">
            <div class="checkbox-row">
                <input type="checkbox" id="f-ia-enabled" ${ia.enabled ? 'checked' : ''}>
                <label for="f-ia-enabled" style="cursor:pointer;margin:0">⏳ Интервальный доступ (окно каждые N минут)</label>
            </div>
        </div>

        <div id="ia-fields" style="display:${ia.enabled ? 'block' : 'none'}">
            <div class="field-row">
                <div class="field">
                    <label>Период цикла (минуты)</label>
                    <input id="f-ia-interval" type="number" min="1" value="${ia.intervalMs ? Math.round(ia.intervalMs / 60000) : 120}">
                    <div class="hint">120 = каждые 2 часа</div>
                </div>
                <div class="field">
                    <label>Длительность окна (минуты)</label>
                    <input id="f-ia-window" type="number" min="1" value="${ia.windowMs ? Math.round(ia.windowMs / 60000) : 15}">
                    <div class="hint">15 = окно 15 минут</div>
                </div>
            </div>
            <div class="field">
                <label>Точка отсчёта</label>
                <input id="f-ia-anchor" type="datetime-local" value="${escapeHtml(iaAnchorValue)}">
                <div class="hint">От этой даты считаются все циклы. Оставьте пустым = 1970-01-01</div>
            </div>
        </div>

        <!-- ======== ПАРОЛЬ ======== -->
        <div class="field-section">
            <div class="checkbox-row">
                <input type="checkbox" id="f-pwd-enabled" ${pwd.enabled ? 'checked' : ''}>
                <label for="f-pwd-enabled" style="cursor:pointer;margin:0">🔒 Требовать пароль для доступа</label>
            </div>
        </div>

        <div id="pwd-fields" style="display:${pwd.enabled ? 'block' : 'none'}">
            <div class="field">
                <label>Режим запроса</label>
                <select id="f-pwd-mode">
                    <option value="requireAlways" ${pwd.mode === 'requireAlways' ? 'selected' : ''}>Спрашивать каждый раз</option>
                    <option value="requireOnce"   ${pwd.mode === 'requireOnce'   ? 'selected' : ''}>Один раз за сессию</option>
                </select>
            </div>
            <div class="field">
                <label>Основной пароль</label>
                <input id="f-pwd-real" type="text" placeholder="${pwd.realHash ? '(оставьте пустым, чтобы не менять)' : 'Введите пароль'}">
                <div class="hint">→ откроет настоящий сайт: ${escapeHtml(s.url || 'URL выше')}</div>
            </div>
            <div class="field">
                <label>Подставной пароль (duress)</label>
                <input id="f-pwd-duress" type="text" placeholder="${pwd.duressHash ? '(оставьте пустым, чтобы не менять)' : 'Введите пароль'}">
                <div class="hint">→ откроет подставной сайт ниже (для сценария принуждения)</div>
            </div>
            <div class="field">
                <label>URL подставного сайта</label>
                <input id="f-pwd-decoy" value="${escapeHtml(pwd.decoyUrl || '')}" placeholder="https://example.com">
            </div>
            <div class="field">
                <label>Название подставного сайта</label>
                <input id="f-pwd-decoy-name" value="${escapeHtml(pwd.decoyName || '')}" placeholder="Example.com">
            </div>
            <div class="field-row">
                <div class="field">
                    <label>Макс. попыток</label>
                    <input id="f-pwd-max" type="number" min="1" value="${pwd.maxAttempts || 3}">
                </div>
                <div class="field">
                    <label>Блокировка после попыток (мин)</label>
                    <input id="f-pwd-block" type="number" min="1" value="${Math.round((pwd.blockDurationMs || 1800000) / 60000)}">
                </div>
            </div>
            <div class="field">
                <label>Подсказка (опционально)</label>
                <input id="f-pwd-hint" value="${escapeHtml(pwd.hint || '')}" placeholder="Связано с восходом">
            </div>
        </div>

        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
            <button type="submit" class="btn btn-primary">${isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
    `, async () => {
        const limitMin = Math.max(1, +$('#f-limit').value || 5);
        const requiredTestIds = $$('#modal-form .test-list input:checked').map(c => c.value);

        const obj = {
            id: $('#f-id').value.trim(),
            url: $('#f-url').value.trim(),
            name: $('#f-name').value.trim(),
            icon: $('#f-icon').value.trim() || '🌐',
            limitMs: limitMin * 60000,
            requiredTestIds,
            geofence: $('#f-geo').value || null,
            schedule: $('#f-sch').value || null,
            intervalAccess: null,
            password: null
        };

        if (!obj.id || !obj.url || !obj.name) {
            toast('Заполните ID, URL и название', 'error');
            return;
        }

        // --- Интервальный доступ ---
        if ($('#f-ia-enabled').checked) {
            const intervalMin = Math.max(1, +$('#f-ia-interval').value || 120);
            const windowMin = Math.max(1, +$('#f-ia-window').value || 15);
            if (windowMin > intervalMin) {
                toast('Окно не может быть больше периода', 'error');
                return;
            }
            const anchorRaw = $('#f-ia-anchor').value;
            obj.intervalAccess = {
                enabled: true,
                intervalMs: intervalMin * 60000,
                windowMs: windowMin * 60000,
                anchorAt: anchorRaw ? localToIso(anchorRaw) : null,
                timezone: DEFAULT_TZ
            };
        }

        // --- Пароль ---
        if ($('#f-pwd-enabled').checked) {
            const realInput = $('#f-pwd-real').value.trim();
            const duressInput = $('#f-pwd-duress').value.trim();
            const realHash = realInput ? await sha256(realInput) : (pwd.realHash || '');
            const duressHash = duressInput ? await sha256(duressInput) : (pwd.duressHash || '');

            if (!realHash) { toast('Введите основной пароль', 'error'); return; }
            if (!duressHash) { toast('Введите подставной пароль', 'error'); return; }

            obj.password = {
                enabled: true,
                mode: $('#f-pwd-mode').value,
                realHash,
                duressHash,
                decoyUrl: $('#f-pwd-decoy').value.trim() || 'https://example.com',
                decoyName: $('#f-pwd-decoy-name').value.trim() || 'Example.com',
                maxAttempts: +$('#f-pwd-max').value || 3,
                blockDurationMs: (+$('#f-pwd-block').value || 30) * 60000,
                hint: $('#f-pwd-hint').value.trim() || null
            };
        }

        if (isNew) STATE.sites.push(obj);
        else STATE.sites[index] = obj;
        saveState(); renderAll(); closeModal();
        toast(isNew ? 'Сайт создан' : 'Сайт сохранён', 'success');
    });

    $('#f-pwd-enabled').onchange = (e) => {
        $('#pwd-fields').style.display = e.target.checked ? 'block' : 'none';
    };
    $('#f-ia-enabled').onchange = (e) => {
        $('#ia-fields').style.display = e.target.checked ? 'block' : 'none';
    };
}

// ---------- ФОРМА ГЕОТОЧКИ ----------
function openGeoForm(index) {
    const isNew = index === null;
    const g = isNew ? { id: uid('geo'), label: '', lat: 0, lon: 0, radiusMeters: 200 } : STATE.geopoints[index];

    openModal(isNew ? 'Новая геоточка' : 'Редактирование геоточки', `
        <div class="field"><label>ID</label><input id="g-id" value="${escapeHtml(g.id)}" required></div>
        <div class="field"><label>Название</label><input id="g-label" value="${escapeHtml(g.label)}" required placeholder="Красная площадь"></div>
        <div class="field-row">
            <div class="field"><label>Широта</label><input id="g-lat" type="number" step="0.000001" value="${g.lat}" required></div>
            <div class="field"><label>Долгота</label><input id="g-lon" type="number" step="0.000001" value="${g.lon}" required></div>
        </div>
        <div class="field">
            <label>Радиус (метры)</label>
            <input id="g-radius" type="number" min="10" value="${g.radiusMeters}" required>
            <div class="hint">Сколько метров вокруг точки считается «внутри»</div>
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
            <button type="submit" class="btn btn-primary">${isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
    `, () => {
        const obj = {
            id: $('#g-id').value.trim(),
            label: $('#g-label').value.trim(),
            lat: +$('#g-lat').value,
            lon: +$('#g-lon').value,
            radiusMeters: +$('#g-radius').value
        };
        if (!obj.id || !obj.label) { toast('Заполните ID и название', 'error'); return; }
        if (isNew) STATE.geopoints.push(obj);
        else STATE.geopoints[index] = obj;
        saveState(); renderAll(); closeModal();
        toast(isNew ? 'Геоточка создана' : 'Геоточка сохранена', 'success');
    });
}

// ---------- ФОРМА РАСПИСАНИЯ ----------
function openScheduleForm(index) {
    const isNew = index === null;
    const s = isNew ? {
        id: uid('sch'), label: '',
        days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', timezone: DEFAULT_TZ
    } : STATE.schedules[index];

    const daysHtml = DAY_NAMES.map((name, i) => `
        <label>
            <input type="checkbox" value="${i}" ${s.days.includes(i) ? 'checked' : ''}>
            ${name}
        </label>
    `).join('');

    openModal(isNew ? 'Новое расписание' : 'Редактирование расписания', `
        <div class="field"><label>ID</label><input id="s-id" value="${escapeHtml(s.id)}" required></div>
        <div class="field"><label>Название</label><input id="s-label" value="${escapeHtml(s.label)}" required placeholder="Будни 9–18"></div>
        <div class="field"><label>Дни недели</label><div class="days">${daysHtml}</div></div>
        <div class="field-row">
            <div class="field"><label>Время с</label><input id="s-from" type="time" value="${s.from}" required></div>
            <div class="field"><label>Время до</label><input id="s-to" type="time" value="${s.to}" required></div>
        </div>
        <div class="field">
            <label>Часовой пояс</label>
            <input id="s-tz" value="${escapeHtml(s.timezone)}" required placeholder="Asia/Krasnoyarsk">
            <div class="hint">IANA-имя: Asia/Krasnoyarsk, Asia/Yekaterinburg, UTC и т.п.</div>
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
            <button type="submit" class="btn btn-primary">${isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
    `, () => {
        const days = $$('#modal-form .days input:checked').map(c => +c.value);
        if (!days.length) { toast('Выберите хотя бы один день', 'error'); return; }
        const obj = {
            id: $('#s-id').value.trim(),
            label: $('#s-label').value.trim(),
            days,
            from: $('#s-from').value,
            to: $('#s-to').value,
            timezone: $('#s-tz').value.trim() || DEFAULT_TZ
        };
        if (isNew) STATE.schedules.push(obj);
        else STATE.schedules[index] = obj;
        saveState(); renderAll(); closeModal();
        toast(isNew ? 'Расписание создано' : 'Расписание сохранено', 'success');
    });
}

// ---------- ФОРМА НАБОРА ТЕСТОВ ----------
function openTestSetForm(index) {
    const isNew = index === null;
    const ts = isNew ? { id: uid('tset'), label: '', testIds: [] } : STATE.testSets[index];

    const checkboxes = STATE.testIndex.map(t => `
        <label class="test-list-item">
            <input type="checkbox" value="${t.id}" ${ts.testIds.includes(t.id) ? 'checked' : ''}>
            <span>${escapeHtml(t.title)} <span style="color:var(--dim)">[${t.category}]</span></span>
        </label>`).join('');

    openModal(isNew ? 'Новый набор тестов' : 'Редактирование набора', `
        <div class="field"><label>ID</label><input id="ts-id" value="${escapeHtml(ts.id)}" required></div>
        <div class="field"><label>Название</label><input id="ts-label" value="${escapeHtml(ts.label)}" required></div>
        <div class="field">
            <label>Тесты в наборе</label>
            <div class="test-list">
                ${checkboxes || '<span style="color:var(--dim);font-size:0.85rem">Нет тестов</span>'}
            </div>
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
            <button type="submit" class="btn btn-primary">${isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
    `, () => {
        const testIds = $$('#modal-form .test-list input:checked').map(c => c.value);
        const obj = {
            id: $('#ts-id').value.trim(),
            label: $('#ts-label').value.trim(),
            testIds
        };
        if (isNew) STATE.testSets.push(obj);
        else STATE.testSets[index] = obj;
        saveState(); renderAll(); closeModal();
        toast(isNew ? 'Набор создан' : 'Набор сохранён', 'success');
    });
}

window.closeModal = closeModal;

// ---------- Импорт ----------
$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').onchange = async (e) => {
    const files = [...e.target.files];
    let loaded = 0;
    for (const file of files) {
        try {
            const json = JSON.parse(await file.text());
            if (Array.isArray(json.sites))           { STATE.sites = json.sites; loaded++; }
            else if (Array.isArray(json.geopoints))  { STATE.geopoints = json.geopoints; loaded++; }
            else if (Array.isArray(json.schedules))  { STATE.schedules = json.schedules; loaded++; }
            else if (Array.isArray(json.testSets))   { STATE.testSets = json.testSets; loaded++; }
            else if (Array.isArray(json.tests)) {
                STATE.testIndex = json.tests.map(t => ({
                    id: t.id,
                    title: t.title || t.id,
                    category: t.category || '?'
                }));
                loaded++;
            }
            else toast(`Неизвестный формат: ${file.name}`, 'warn');
        } catch (err) {
            toast(`Ошибка ${file.name}: ${err.message}`, 'error');
        }
    }
    saveState(); renderAll();
    e.target.value = '';
    if (loaded) toast(`Загружено файлов: ${loaded}`, 'success');
};

// ---------- Экспорт ----------
$('#btn-export').onclick = () => {
    downloadJson('sites.json', {
        sites: STATE.sites,
        globalBlockDurationMs: 7200000,
        allowParallelOpen: false,
        geolocation: { timeoutMs: 10000, maximumAge: 60000, enableHighAccuracy: true }
    });
    downloadJson('geopoints.json', { geopoints: STATE.geopoints });
    downloadJson('schedules.json', { schedules: STATE.schedules });
    downloadJson('test-sets.json', { testSets: STATE.testSets });
    toast('Экспортировано 4 файла', 'success');
};

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Предпросмотр ----------
$('#btn-preview').onclick = () => {
    const blocks = [
        { name: 'sites.json',     data: { sites: STATE.sites } },
        { name: 'geopoints.json', data: { geopoints: STATE.geopoints } },
        { name: 'schedules.json', data: { schedules: STATE.schedules } },
        { name: 'test-sets.json', data: { testSets: STATE.testSets } }
    ];

    $('#preview-body').innerHTML = blocks.map(b => `
        <div class="preview-block">
            <h3>
                ${b.name}
                <button class="btn btn-secondary copy-btn" data-copy="${b.name}">📋</button>
            </h3>
            <pre id="preview-${b.name}">${escapeHtml(JSON.stringify(b.data, null, 2))}</pre>
        </div>
    `).join('');

    $$('.copy-btn').forEach(b => b.onclick = () => {
        const name = b.dataset.copy;
        const text = $(`#preview-${name}`).textContent;
        navigator.clipboard.writeText(text);
        toast(`${name} скопирован`, 'success');
    });

    $('#preview').classList.remove('hidden');
};
$('#preview-close').onclick = () => $('#preview').classList.add('hidden');
$('#preview').onclick = (e) => { if (e.target.id === 'preview') $('#preview').classList.add('hidden'); };

// ---------- Вкладки ----------
$$('.tab-btn').forEach(tab => {
    tab.onclick = () => {
        $$('.tab-btn').forEach(t => t.classList.remove('active'));
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        $('#tab-' + tab.dataset.tab).classList.add('active');
    };
});

// ---------- Загрузка tests/index.json ----------
async function tryLoadTestIndex(force = false) {
    if (STATE.testIndex.length && !force) return;
    const candidates = ['../tests/index.json', './tests/index.json', '/tests/index.json'];
    for (const path of candidates) {
        try {
            const res = await fetch(path, { cache: 'no-store' });
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data.tests)) {
                STATE.testIndex = data.tests.map(t => ({
                    id: t.id,
                    title: t.title || t.id,
                    category: t.category || '?'
                }));
                console.log('✅ tests/index.json загружен:', STATE.testIndex.length);
                return;
            }
        } catch (e) { /* следующая попытка */ }
    }
    console.warn('⚠️ tests/index.json не автозагружен');
}

// ============================================
// СТАРТ
// ============================================
(async function init() {
    // 1. Проверка доступа к редактору
    const allowed = await checkEditorAccess();
    if (!allowed) {
        console.log('🔒 Редактор закрыт по расписанию');
        const retryBtn = document.getElementById('lock-retry');
        if (retryBtn) {
            retryBtn.onclick = async () => {
                document.getElementById('lock-screen').classList.add('hidden');
                const ok = await checkEditorAccess();
                if (!ok) document.getElementById('lock-screen').classList.remove('hidden');
            };
        }
        return;
    }

    // 2. Обычная инициализация
    loadState();
    await tryLoadTestIndex();
    renderAll();
    console.log('✅ Редактор готов (tz:', DEFAULT_TZ + ')');
})();