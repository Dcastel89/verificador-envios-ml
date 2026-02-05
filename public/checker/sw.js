// Service Worker para Chequeador de Productos
var CACHE_NAME = 'chequeador-v1';
var urlsToCache = [
  '/checker/',
  '/checker/index.html',
  '/checker/manifest.json'
];

// Instalación
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('Cache chequeador abierto');
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// Activación - limpiar caches viejos
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch - network first, fallback to cache
self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
