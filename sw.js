const CACHE = 'sarmaye-v24-31';
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
  './bank-resalat.png',
  './Vazirmatn.woff2',
  './Lalezar.ttf'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // cache:'reload' bypasses the browser's HTTP cache for the precache fetch itself,
      // so a fresh sw.js also means a genuinely fresh copy of every precached file
      .then(c => c.addAll(FILES.map(f => new Request(f, {cache:'reload'}))))
      // Leave activation to the browser while an older page is still open.
      // A failed install must never replace the working offline application.
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('sarmaye-') && k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    // Network-first AND cache:'no-store' — this bypasses the browser's own HTTP cache,
    // not just the service worker cache. Without this, a GitHub Pages / Firebase Hosting
    // Cache-Control header could make "network-first" silently return a stale cached
    // response, which was the actual cause of needing a manual cache clear on updates.
    // v24.2: never hang on a filtered/slow network — after 3 s fall back to the cached app.
    const net = fetch(req, {cache:'no-store'}).then(res => {
      if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) {
        throw new Error('Invalid application response');
      }
      const cp = res.clone();
      e.waitUntil(caches.open(CACHE).then(c => c.put(req, cp)).catch(()=>{}));
      return res;
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
    e.respondWith(
      Promise.race([net, timeout]).catch(async () =>
        (await caches.match(req)) || (await caches.match('./')) ||
        new Response('برنامه آفلاین هنوز آماده نیست. دوباره با اینترنت باز کنید.', {
          status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}
        }))
    );
    return;
  }
  // Cache-first for static assets (icons, manifest, etc.)
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
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
