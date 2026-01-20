// Service Worker para Verificador Envíos ML
var CACHE_NAME = 'verificador-v2';
var urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Instalación
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('Cache abierto');
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
            console.log('Eliminando cache viejo:', cacheName);
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
