// ============================================
// sw.js
// Статика — cache-first, JSON — network-first
// ============================================
const CACHE_NAME = 'trener-v3';
const PRECACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './registry.js',
    './manifest.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(c => c.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;

    const url = new URL(e.request.url);

    // Пропускаем запросы к сторонним доменам (время, шрифты и т.п.)
    if (url.origin !== location.origin) return;

    // JSON — network-first: контент всегда свежий
    if (url.pathname.endsWith('.json')) {
        e.respondWith(
            fetch(e.request)
                .then(r => {
                    const copy = r.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
                    return r;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Остальное — cache-first с фоновым обновлением
    e.respondWith(
        caches.match(e.request).then(cached => {
            const fetched = fetch(e.request)
                .then(r => {
                    const copy = r.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
                    return r;
                })
                .catch(() => cached);
            return cached || fetched;
        })
    );
});