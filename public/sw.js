// Service worker for the installed app.
// It only keeps the look of the site (styles, logos) and an offline page.
// Pages with members' money details are never stored on the phone: they always come fresh from the server.
const VERSION = 'v1'; // bump to replace the saved offline page and styles
const SHELL = `shell-${VERSION}`;
const PRECACHE = ['/offline.html', '/css/app.css', '/img/brand/logo-mark.svg', '/img/brand/logo-mark-reverse.svg', '/img/brand/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isStatic = url => url.origin === location.origin && /^\/(css|img|js)\//.test(url.pathname);

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pages: always from the network. If there is no connection, show the offline page instead of an error.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Styles and images: fresh from the network when online (so updates show at once), the saved copy when offline.
  if (isStatic(url)) {
    event.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
  }
  // Everything else (data, M-Pesa status, downloads) goes straight to the network untouched.
});
