const CACHE = 'sarmaye-v15';
const FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-32.png',
  './icon-152.png',
  './icon-167.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './bank-meli.png',
  './bank-mellat.png',
  './bank-refah.png',
  './bank-shahr.png',
  './bank-tejarat.png',
  './bank-resalat.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    // Network-first for the app shell: always get the latest version when online,
    // so future updates reach users immediately without needing a new cache version.
    e.respondWith(
      fetch(req)
        .then(res => {
          caches.open(CACHE).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./')))
    );
    return;
  }
  // Cache-first for static assets (icons, manifest, etc.)
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).catch(() => caches.match('./')))
  );
});

// Push notifications support
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'سرمایه', {
      body: data.body || 'یادآور اجاره',
      icon: './icon-192.png',
      badge: './icon-32.png',
      dir: 'rtl',
      lang: 'fa'
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('./'));
});
