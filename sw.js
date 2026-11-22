// PagePal service worker: makes the app open and work without wifi.
//
// Strategy:
// - The app's own pages, code and styles: network first, so an update pushed
//   to GitHub shows up straight away. If the network is slow (over 4 s) or
//   missing, the saved copy is used, so it still works without wifi.
// - Libraries, fonts and icons (lib/, fonts/, icons/), which rarely change:
//   saved copy first, refreshed in the background.
// Bump CACHE_VERSION (and APP_VERSION in js/config.js) with each release so
// old copies are cleared.

const CACHE_VERSION = 'pagepal-v0.9.12';

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
  'js/templates.js',
  'js/send.js',
  'js/pdf-writer.js',
  'js/page-text.js',
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

const NETWORK_TIMEOUT_MS = 4000;
const STATIC = /\/(lib|fonts|icons)\//;

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle our own files. Google Drive, speech services etc. go straight to the network.
  if (url.origin !== self.location.origin) return;
  event.respondWith(STATIC.test(url.pathname) ? cacheFirst(req) : networkFirst(req));
});

/**
 * The app's own pages and code: from the network, asking the server every
 * time (GitHub Pages otherwise lets browsers reuse a file for 10 minutes),
 * so an update arrives straight away and old and new files never mix.
 * The request keeps its kind (page, script, worker…): Safari refuses
 * scripts fetched as a different kind of request.
 */
async function fromNetwork(req, cache) {
  const res = req.mode === 'navigate'
    ? await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) // a page request can't be copied
    : await fetch(req, { cache: 'no-cache' });
  if (res.ok && res.status === 200 && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const network = fromNetwork(req, cache);
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network.catch(() => null), timeout]);
    if (res) return res;
  } catch { /* fall back to the cache */ }
  // Ignore ?pdf=… style query strings when matching the app page itself.
  const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (cached) return cached;
  if (req.mode === 'navigate') {
    const page = await cache.match('index.html');
    if (page) return page;
  }
  return network; // still waiting? use it when it arrives
}

/**
 * Libraries, fonts and icons (including the 4 MB text reader): kept once per
 * PagePal version, fetched exactly as the browser asked for them. They only
 * change with a new version, which starts a fresh cache.
 */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && res.status === 200 && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
  return res;
}
