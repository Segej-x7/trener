// ============================================
// editor.js — простой редактор правил
// ============================================

const STORAGE_KEY = 'rulesEditorState';
const RULES_URL = '../access/rules.json';

// Состояние
const STATE = {
    locations: [],
    timeWindows: [],
    sites: []
};

// ============================================
// УТИЛИТЫ
// ============================================
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const DAYS_FULL  = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const DAYS_SHORT = { 'пн':'Пн', 'вт':'Вт', 'ср':'Ср', 'чт':'Чт', 'пт':'Пт', 'сб':'Сб', 'вс':'Вс' };

function escapeHtml(t) {
    return String(t ?? '').replace(/[&<>"']/g,
        m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

function toast(msg, type = 'info', duration = 3500) {
    const root = $('#toast-root');
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
        if (!raw) return false;
        const data = JSON.parse(raw);
        Object.assign(STATE, data);
        return true;
    } catch { return false; }
}

// ============================================
// ЗАГРУЗКА С СЕРВЕРА (rules.json)
// ============================================
async function tryLoadFromServer() {
    try {
        const res = await fetch(RULES_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        STATE.locations = data.locations || [];
        STATE.timeWindows = data.timeWindows || [];
        STATE.sites = data.sites || [];
        console.log('✅ rules.json загружен с сервера');
        return true;
    } catch (e) {
        console.warn('⚠️ rules.json с сервера не загружен:', e.message);
        return false;
    }
}

// ============================================
// РЕНДЕР
// ============================================
function renderAll() {
    renderSites();
    renderLocations();
    renderWindows();
}

// ----- САЙТЫ -----
function renderSites() {
    const list = $('#sites-list');
    if (!STATE.sites.length) {
        list.innerHTML = '<div class="empty">Пока нет сайтов. Нажмите «Добавить».</div>';
        return;
    }

    list.innerHTML = '';
    STATE.sites.forEach((site, idx) => {
        const el = document.createElement('div');
        el.className = 'card';

        const badges = [];
        badges.push(`<span class="badge">⏱ ${site.minutesPerDay} мин/день</span>`);
        if (site.location)    badges.push(`<span class="badge badge-info">📍 ${escapeHtml(site.location)}</span>`);
        if (site.timeWindow)  badges.push(`<span class="badge badge-warn">🕐 ${escapeHtml(site.timeWindow)}</span>`);
        if (site.intervalWindow) {
            badges.push(`<span class="badge badge-info">⏳ ${site.intervalWindow.windowMinutes}/${site.intervalWindow.intervalMinutes} мин</span>`);
        }
        if (site.tests?.length) badges.push(`<span class="badge badge-info">📚 ${site.tests.length}</span>`);
        if (site.password)      badges.push(`<span class="badge badge-pwd">🔒 Пароль</span>`);

        el.innerHTML = `
            <div class="card-body">
                <div class="card-title">${escapeHtml(site.icon || '🌐')} ${escapeHtml(site.name)}</div>
                <div class="card-sub">${escapeHtml(site.url)}</div>
                <div class="card-badges">${badges.join('')}</div>
            </div>
            <div class="card-actions">
                <button class="btn btn-secondary btn-small" data-edit="${idx}">✏️</button>
                <button class="btn btn-danger btn-small" data-del="${idx}">🗑</button>
            </div>
        `;

        el.querySelector('[data-edit]').onclick = (e) => { e.stopPropagation(); openSiteForm(idx); };
        el.querySelector('[data-del]').onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Удалить сайт «${site.name}»?`)) {
                STATE.sites.splice(idx, 1);
                saveState(); renderSites();
                toast('Удалено', 'success');
            }
        };
        el.onclick = () => openSiteForm(idx);
        list.appendChild(el);
    });
}

// ----- МЕСТА -----
function renderLocations() {
    const list = $('#locations-list');
    if (!STATE.locations.length) {
        list.innerHTML = '<div class="empty">Пока нет мест. Нажмите «Добавить».</div>';
        return;
    }

    list.innerHTML = '';
    STATE.locations.forEach((loc, idx) => {
        const usedIn = STATE.sites.filter(s => s.location === loc.name).length;
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = `
            <div class="card-body">
                <div class="card-title">📍 ${escapeHtml(loc.name)}</div>
                <div class="card-sub">${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}</div>
                <div class="card-badges">
                    <span class="badge">Радиус ${loc.radius} м</span>
                    ${usedIn ? `<span class="badge badge-ok">в ${usedIn} сайтах</span>` : ''}
                </div>
            </div>
            <div class="card-actions">
                <button class="btn btn-secondary btn-small" data-edit="${idx}">✏️</button>
                <button class="btn btn-danger btn-small" data-del="${idx}">🗑</button>
            </div>
        `;
        el.querySelector('[data-edit]').onclick = () => openLocationForm(idx);
        el.querySelector('[data-del]').onclick = () => {
            if (usedIn) {
                if (!confirm(`Место используется в ${usedIn} сайтах. Удалить?`)) return;
            } else if (!confirm('Удалить место?')) return;
            STATE.locations.splice(idx, 1);
            saveState(); renderAll();
            toast('Удалено', 'success');
        };
        list.appendChild(el);
    });
}

// ----- ВРЕМЕННЫЕ ОКНА -----
function renderWindows() {
    const list = $('#windows-list');
    if (!STATE.timeWindows.length) {
        list.innerHTML = '<div class="empty">Пока нет окон. Нажмите «Добавить».</div>';
        return;
    }

    list.innerHTML = '';
    STATE.timeWindows.forEach((w, idx) => {
        const usedIn = STATE.sites.filter(s => s.timeWindow === w.name).length;
        const days = w.days.map(d => DAYS_SHORT[d] || d).join(', ');
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = `
            <div class="card-body">
                <div class="card-title">🕐 ${escapeHtml(w.name)}</div>
                <div class="card-sub">${days} · ${w.from}–${w.to}</div>
                <div class="card-badges">
                    <span class="badge">${escapeHtml(w.timezone || '')}</span>
                    ${usedIn ? `<span class="badge badge-ok">в ${usedIn} сайтах</span>` : ''}
                </div>
            </div>
            <div class="card-actions">
                <button class="btn btn-secondary btn-small" data-edit="${idx}">✏️</button>
                <button class="btn btn-danger btn-small" data-del="${idx}">🗑</button>
            </div>
        `;
        el.querySelector('[data-edit]').onclick = () => openWindowForm(idx);
        el.querySelector('[data-del]').onclick = () => {
            if (usedIn) {
                if (!confirm(`Окно используется в ${usedIn} сайтах. Удалить?`)) return;
            } else if (!confirm('Удалить окно?')) return;
            STATE.timeWindows.splice(idx, 1);
            saveState(); renderAll();
            toast('Удалено', 'success');
        };
        list.appendChild(el);
    });
}

// ============================================
// МОДАЛКА
// ============================================
function openModal(title, bodyHtml) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal').classList.remove('hidden');
}

function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modal-body').innerHTML = '';
}

$('#modal-close').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

// ============================================
// ФОРМА САЙТА
// ============================================
function openSiteForm(index) {
    const isNew = index === null;
    const s = isNew ? {
        name: '', url: '', icon: '🌐', minutesPerDay: 10,
        location: null, timeWindow: null, intervalWindow: null,
        tests: [], password: null
    } : JSON.parse(JSON.stringify(STATE.sites[index]));

    // Радио-кнопки мест
    const locationRadios = [
        `<label class="radio-row"><input type="radio" name="loc" value="" ${!s.location ? 'checked' : ''}> Везде</label>`,
        ...STATE.locations.map(loc =>
            `<label class="radio-row"><input type="radio" name="loc" value="${escapeHtml(loc.name)}" ${s.location === loc.name ? 'checked' : ''}> ${escapeHtml(loc.name)}</label>`
        )
    ].join('');

    // Радио-кнопки временных окон
    const windowRadios = [
        `<label class="radio-row"><input type="radio" name="win" value="" ${!s.timeWindow ? 'checked' : ''}> Всегда</label>`,
        ...STATE.timeWindows.map(w =>
            `<label class="radio-row"><input type="radio" name="win" value="${escapeHtml(w.name)}" ${s.timeWindow === w.name ? 'checked' : ''}> ${escapeHtml(w.name)}</label>`
        )
    ].join('');

    // Интервальное окно
    const iw = s.intervalWindow || {};

    // Пароль
    const p = s.password || {};

    openModal(isNew ? 'Новый сайт' : 'Редактирование сайта', `
        <div class="field">
            <label>Название</label>
            <input type="text" id="f-name" value="${escapeHtml(s.name)}" placeholder="Wikipedia">
        </div>
        <div class="field">
            <label>Адрес сайта</label>
            <input type="url" id="f-url" value="${escapeHtml(s.url)}" placeholder="https://wikipedia.org">
        </div>
        <div class="field-row">
            <div class="field">
                <label>Иконка</label>
                <input type="text" id="f-icon" value="${escapeHtml(s.icon)}" maxlength="4">
            </div>
            <div class="field">
                <label>Лимит в день (мин)</label>
                <input type="number" id="f-minutes" min="1" value="${s.minutesPerDay}">
            </div>
        </div>

        <div class="form-section">
            <h3 class="form-section-title">📍 Где открывать</h3>
            ${locationRadios || '<p class="field-hint">Сначала добавьте места во вкладке «Места»</p>'}
        </div>

        <div class="form-section">
            <h3 class="form-section-title">🕐 Когда открывать</h3>
            ${windowRadios}
        </div>

        <div class="form-section">
            <h3 class="form-section-title">⏳ Интервальный доступ</h3>
            <label class="checkbox-row">
                <input type="checkbox" id="f-iw-enabled" ${iw.intervalMinutes ? 'checked' : ''}>
                Ограничить окнами (например: 15 мин каждые 2 часа)
            </label>
            <div id="iw-fields" style="display:${iw.intervalMinutes ? 'block' : 'none'};margin-top:10px">
                <div class="field-row">
                    <div class="field">
                        <label>Окно (мин)</label>
                        <input type="number" id="f-iw-window" min="1" value="${iw.windowMinutes || 15}">
                    </div>
                    <div class="field">
                        <label>Каждые (мин)</label>
                        <input type="number" id="f-iw-interval" min="1" value="${iw.intervalMinutes || 120}">
                    </div>
                </div>
                <div class="field">
                    <label>Точка отсчёта</label>
                    <input type="datetime-local" id="f-iw-anchor" value="${escapeHtml(iw.anchor || '2026-01-01T00:00')}">
                    <div class="field-hint">От этой даты считаются окна</div>
                </div>
            </div>
        </div>

        <div class="form-section">
            <h3 class="form-section-title">📚 Тесты</h3>
            <div id="tests-container">
                ${renderTestCheckboxes(s.tests)}
            </div>
        </div>

        <div class="form-section">
            <h3 class="form-section-title">🔒 Пароль</h3>
            <label class="checkbox-row">
                <input type="checkbox" id="f-pwd-enabled" ${p.real ? 'checked' : ''}>
                Требовать пароль
            </label>
            <div id="pwd-fields" style="display:${p.real ? 'block' : 'none'};margin-top:10px">
                <div class="field">
                    <label>Основной пароль</label>
                    <input type="text" id="f-pwd-real" value="${escapeHtml(p.real || '')}" placeholder="Открывает настоящий сайт">
                </div>
                <div class="field">
                    <label>Подставной пароль</label>
                    <input type="text" id="f-pwd-duress" value="${escapeHtml(p.duress || '')}" placeholder="Открывает decoy">
                    <div class="field-hint">Если вас заставят ввести пароль — вводите этот</div>
                </div>
                <div class="field">
                    <label>URL подставного сайта</label>
                    <input type="url" id="f-pwd-decoy-url" value="${escapeHtml(p.decoyUrl || '')}" placeholder="https://example.com">
                </div>
                <div class="field">
                    <label>Название подставного</label>
                    <input type="text" id="f-pwd-decoy-name" value="${escapeHtml(p.decoyName || '')}" placeholder="Example.com">
                </div>
                <div class="field-row">
                    <div class="field">
                        <label>Попыток</label>
                        <input type="number" id="f-pwd-attempts" min="1" value="${p.maxAttempts || 3}">
                    </div>
                    <div class="field">
                        <label>Блок (мин)</label>
                        <input type="number" id="f-pwd-block" min="1" value="${p.blockMinutes || 30}">
                    </div>
                </div>
                <div class="field">
                    <label>Режим</label>
                    <select id="f-pwd-mode">
                        <option value="requireAlways" ${p.mode === 'requireAlways' ? 'selected' : ''}>Каждый раз</option>
                        <option value="requireOnce"   ${p.mode === 'requireOnce'   ? 'selected' : ''}>Раз за сессию</option>
                    </select>
                </div>
                <div class="field">
                    <label>Подсказка (опционально)</label>
                    <input type="text" id="f-pwd-hint" value="${escapeHtml(p.hint || '')}" placeholder="Связано с восходом">
                </div>
            </div>
        </div>

        <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="f-cancel">Отмена</button>
            <button type="button" class="btn btn-primary" id="f-save">${isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
    `);

    // Показ интервального блока
    $('#f-iw-enabled').onchange = (e) => {
        $('#iw-fields').style.display = e.target.checked ? 'block' : 'none';
    };

    // Показ пароля
    $('#f-pwd-enabled').onchange = (e) => {
        $('#pwd-fields').style.display = e.target.checked ? 'block' : 'none';
    };

    // Отмена
    $('#f-cancel').onclick = closeModal;

    // Сохранить
    $('#f-save').onclick = () => {
        const name = $('#f-name').value.trim();
        const url = $('#f-url').value.trim();
        if (!name) { toast('Введите название', 'error'); return; }
        if (!url) { toast('Введите адрес', 'error'); return; }

        const obj = {
            name,
            url,
            icon: $('#f-icon').value.trim() || '🌐',
            minutesPerDay: Math.max(1, +$('#f-minutes').value || 10),
            location: $$('input[name="loc"]').find(r => r.checked)?.value || null,
            timeWindow: $$('input[name="win"]').find(r => r.checked)?.value || null,
            intervalWindow: null,
            tests: $$('#tests-container input:checked').map(c => c.value),
            password: null
        };

        // Интервальный доступ
        if ($('#f-iw-enabled').checked) {
            obj.intervalWindow = {
                windowMinutes: Math.max(1, +$('#f-iw-window').value || 15),
                intervalMinutes: Math.max(1, +$('#f-iw-interval').value || 120),
                anchor: $('#f-iw-anchor').value || '2026-01-01T00:00'
            };
        }

        // Пароль
        if ($('#f-pwd-enabled').checked) {
            const real = $('#f-pwd-real').value.trim();
            const duress = $('#f-pwd-duress').value.trim();
            if (!real) { toast('Введите основной пароль', 'error'); return; }
            if (!duress) { toast('Введите подставной пароль', 'error'); return; }

            obj.password = {
                real,
                duress,
                decoyUrl: $('#f-pwd-decoy-url').value.trim() || 'https://example.com',
                decoyName: $('#f-pwd-decoy-name').value.trim() || 'Example.com',
                maxAttempts: +$('#f-pwd-attempts').value || 3,
                blockMinutes: +$('#f-pwd-block').value || 30,
                mode: $('#f-pwd-mode').value,
                hint: $('#f-pwd-hint').value.trim() || null
            };
        }

        if (isNew) STATE.sites.push(obj);
        else STATE.sites[index] = obj;

        saveState(); renderAll(); closeModal();
        toast(isNew ? 'Сайт создан' : 'Сайт сохранён', 'success');
    };
}

function renderTestCheckboxes(selected) {
    // Список тестов захардкожен — при необходимости обновляйте
    const tests = [
        { id: 'html-basics',           title: 'HTML: Основы' },
        { id: 'html-formatting',       title: 'HTML: Форматирование' },
        { id: 'html-forms-frames',     title: 'HTML: Формы' },
        { id: 'html-media-links',      title: 'HTML: Медиа' },
        { id: 'html-semantics-tables', title: 'HTML: Семантика' },
        { id: 'css-basics',            title: 'CSS: Основы' },
        { id: 'css-text-font',         title: 'CSS: Текст' },
        { id: 'css-box-model',         title: 'CSS: Блоки' },
        { id: 'css-position-display',  title: 'CSS: Позиции' },
        { id: 'css-flex-grid',         title: 'CSS: Flex/Grid' },
        { id: 'css-animations',        title: 'CSS: Анимации' },
        { id: 'js-basics',             title: 'JS: Основы' },
        { id: 'js-arrays',             title: 'JS: Массивы' },
        { id: 'js-functions',          title: 'JS: Функции' }
    ];
    return tests.map(t => `
        <label class="checkbox-row">
            <input type="checkbox" value="${t.id}" ${selected?.includes(t.id) ? 'checked' : ''}>
            ${escapeHtml(t.title)}
        </label>
    `).join('');
}

// ============================================
// ФОРМА МЕСТА
// ============================================
function openLocationForm(index) {
    const isNew = index === null;
    const l = isNew ? { name: '', lat: 0, lon: 0, radius: 100 } : STATE.locations[index];

    openModal(isNew ? 'Новое место' : 'Редактирование места', `
        <div class="field">
            <label>Название</label>
            <input type="text" id="l-name" value="${escapeHtml(l.name)}" placeholder="Дом">
        </div>
        <div class="field-row">
            <div class="field">
                <label>Широта</label>
                <input type="number" id="l-lat" step="0.000001" value="${l.lat}">
            </div>
            <div class="field">
                <label>Долгота</label>
                <input type="number" id="l-lon" step="0.000001" value="${l.lon}">
            </div>
        </div>
        <div class="field">
            <label>Радиус (метры)</label>
            <input type="number" id="l-radius" min="10" value="${l.radius}">
            <div class="field-hint">Сколько метров вокруг точки считается «внутри»</div>
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="l-cancel">Отмена</button>
            <button type="button" class="btn btn-primary" id="l-save">${isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
    `);

    $('#l-cancel').onclick = closeModal;
    $('#l-save').onclick = () => {
        const name = $('#l-name').value.trim();
        if (!name) { toast('Введите название', 'error'); return; }
        const obj = {
            name,
            lat: +$('#l-lat').value || 0,
            lon: +$('#l-lon').value || 0,
            radius: Math.max(10, +$('#l-radius').value || 100)
        };
        if (isNew) STATE.locations.push(obj);
        else STATE.locations[index] = obj;
        saveState(); renderAll(); closeModal();
        toast(isNew ? 'Место создано' : 'Место сохранено', 'success');
    };
}

// ============================================
// ФОРМА ВРЕМЕННОГО ОКНА
// ============================================
function openWindowForm(index) {
    const isNew = index === null;
    const w = isNew ? {
        name: '', days: ['пн', 'вт', 'ср', 'чт', 'пт'],
        from: '09:00', to: '18:00', timezone: 'Asia/Krasnoyarsk'
    } : STATE.timeWindows[index];

    const daysHtml = DAYS_FULL.map(d => `
        <label class="${w.days.includes(d) ? 'checked' : ''}">
            <input type="checkbox" value="${d}" ${w.days.includes(d) ? 'checked' : ''}>
            ${DAYS_SHORT[d]}
        </label>
    `).join('');

    openModal(isNew ? 'Новое окно' : 'Редактирование окна', `
        <div class="field">
            <label>Название</label>
            <input type="text" id="w-name" value="${escapeHtml(w.name)}" placeholder="Будни 9–18">
        </div>
        <div class="field">
            <label>Дни недели</label>
            <div class="days" id="w-days">${daysHtml}</div>
        </div>
        <div class="field-row">
            <div class="field">
                <label>С</label>
                <input type="time" id="w-from" value="${w.from}">
            </div>
            <div class="field">
                <label>До</label>
                <input type="time" id="w-to" value="${w.to}">
            </div>
        </div>
        <div class="field">
            <label>Часовой пояс</label>
            <input type="text" id="w-tz" value="${escapeHtml(w.timezone)}" placeholder="Asia/Krasnoyarsk">
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="w-cancel">Отмена</button>
            <button type="button" class="btn btn-primary" id="w-save">${isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
    `);

    // Клик по лейблу — обновить визуальный класс
    $$('#w-days label').forEach(label => {
        label.onclick = () => {
            const cb = label.querySelector('input');
            setTimeout(() => {
                label.classList.toggle('checked', cb.checked);
            }, 0);
        };
    });

    $('#w-cancel').onclick = closeModal;
    $('#w-save').onclick = () => {
        const name = $('#w-name').value.trim();
        if (!name) { toast('Введите название', 'error'); return; }
        const days = $$('#w-days input:checked').map(c => c.value);
        if (!days.length) { toast('Выберите хотя бы один день', 'error'); return; }

        const obj = {
            name, days,
            from: $('#w-from').value || '09:00',
            to: $('#w-to').value || '18:00',
            timezone: $('#w-tz').value.trim() || 'Asia/Krasnoyarsk'
        };
        if (isNew) STATE.timeWindows.push(obj);
        else STATE.timeWindows[index] = obj;
        saveState(); renderAll(); closeModal();
        toast(isNew ? 'Окно создано' : 'Окно сохранено', 'success');
    };
}

// ============================================
// ЭКСПОРТ / ИМПОРТ
// ============================================
$('#btn-export').onclick = () => {
    const data = {
        version: '1.0',
        locations: STATE.locations,
        timeWindows: STATE.timeWindows,
        sites: STATE.sites
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rules.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('rules.json скачан — загрузите его на GitHub в access/', 'success', 6000);
};

$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const json = JSON.parse(await file.text());
        STATE.locations = json.locations || [];
        STATE.timeWindows = json.timeWindows || [];
        STATE.sites = json.sites || [];
        saveState(); renderAll();
        toast('Файл загружен', 'success');
    } catch (err) {
        toast('Ошибка: ' + err.message, 'error');
    }
    e.target.value = '';
};

// ============================================
// ПРЕДПРОСМОТР
// ============================================
$('#btn-preview').onclick = () => {
    const data = {
        version: '1.0',
        locations: STATE.locations,
        timeWindows: STATE.timeWindows,
        sites: STATE.sites
    };
    $('#preview-body').textContent = JSON.stringify(data, null, 2);
    $('#preview').classList.remove('hidden');
};

$('#preview-close').onclick = () => $('#preview').classList.add('hidden');
$('#preview').onclick = (e) => { if (e.target.id === 'preview') $('#preview').classList.add('hidden'); };

$('#preview-copy').onclick = () => {
    navigator.clipboard.writeText($('#preview-body').textContent);
    toast('Скопировано', 'success');
};

// ============================================
// ПОМОЩЬ
// ============================================
$('#btn-help').onclick = () => $('#help').classList.remove('hidden');
$('#help-close').onclick = () => $('#help').classList.add('hidden');
$('#help').onclick = (e) => { if (e.target.id === 'help') $('#help').classList.add('hidden'); };

// ============================================
// ДОБАВЛЕНИЕ
// ============================================
$('#add-site').onclick = () => openSiteForm(null);
$('#add-location').onclick = () => openLocationForm(null);
$('#add-window').onclick = () => openWindowForm(null);

// ============================================
// СТАРТ
// ============================================
(async function init() {
    // 1. Пробуем загрузить с сервера
    const loadedFromServer = await tryLoadFromServer();

    // 2. Если с сервера не получилось — пробуем localStorage
    if (!loadedFromServer) {
        const loadedFromStorage = loadState();
        if (loadedFromStorage) {
            toast('Загружено из браузера (черновик)', 'warn');
        } else {
            toast('Нет данных — начните с нуля или загрузите файл', 'info');
        }
    }

    renderAll();
    console.log('✅ Редактор готов');
})();