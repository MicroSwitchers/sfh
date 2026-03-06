const CACHE_NAME = 'sfh-v8-clean';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './manifest.json',
    './icon.svg'
];

// Install Event - Cache Assets
self.addEventListener('install', (event) => {
    // Skip waiting immediately - don't wait for old SW to finish
    self.skipWaiting();
    
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching all assets');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// Message Event - Handle skipWaiting
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (event) => {
    // Claim clients to take control immediately
    event.waitUntil(clients.claim());
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(
                keyList.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[Service Worker] Removing old cache', key);
                        return caches.delete(key);
                    }
                })
            );
        })
    );
});

// Fetch Event
self.addEventListener('fetch', (event) => {
    // 1. For HTML requests (navigation), ALWAYS try Network first with cache busting
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request.url + '?v=' + CACHE_NAME, { 
                cache: 'no-store' 
            })
                .then((networkResponse) => {
                    return caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });
                })
                .catch(() => {
                    // Only use cache if completely offline
                    return caches.match(event.request);
                })
        );
    } else {
        // 2. For everything else (assets), Cache first, then Network.
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(event.request).then((networkResponse) => {
                    return caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });
                });
            })
        );
    }
});
