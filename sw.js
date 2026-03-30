// Service Worker нужен для того, чтобы приложение кэшировалось
// и могло работать или запускаться даже при нестабильном или отсутствующем интернете.

const CACHE_NAME = 'family-p2p-v1';
const urlsToCache = [
    './',
    './index.html'
];

// Установка Service Worker и кэширование основных файлов
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Кэш открыт');
                return cache.addAll(urlsToCache);
            })
    );
});

// Перехват запросов: если файл есть в кэше - отдаем его, иначе скачиваем из сети
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                return response || fetch(event.request);
            })
    );
});

// Обновление кэша (удаление старых версий при выходе новой)
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});