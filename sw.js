// PagePal service worker: makes the app open and work without wifi.
//
// Strategy: "stale while revalidate" for the app's own files — serve the
// saved copy instantly, then fetch a fresh copy in the background for next
// time. So after you push a change to GitHub, students get it on their
// second open. Bump CACHE_VERSION (and APP_VERSION in js/config.js) with
// each release so old copies are cleared.

const CACHE_VERSION = 'pagepal-v0.3.0';

const APP_SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'fonts/OpenDyslexic-Regular.otf',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
  'js/app.js',
  'js/config.js',
  'js/ui.js',
  'js/settings.js',
  'js/display-modes.js',
  'js/tts.js',
  'js/dictation.js',
  'js/readable.js',
  'js/session-log.js',
  'js/export.js',
  'js/store.js',
  'js/links.js',
  'js/remote.js',
  'js/pdf-doc.js',
  'js/docx-doc.js',
  'js/image-tools.js',
  'js/worksheets.js',
  'js/crop.js',
  'js/qr-scan.js',
  'js/viewer.js',
  'js/annotate.js',
  'js/send.js',
  'js/teacher.js',
  'teacher.html',
  'teacher.css',
  'lib/pdfjs/pdf.min.js',
  'lib/pdfjs/pdf.worker.min.js',
  'lib/jsQR.js',
  'lib/qrcode.js',
  // The Word libraries (lib/docx) and PDF fonts are cached the first time they're used.
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle our own files. Google Drive, speech services etc. go straight to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Ignore ?pdf=… style query strings when matching the app page itself.
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req)
      .then(res => {
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  })());
});
