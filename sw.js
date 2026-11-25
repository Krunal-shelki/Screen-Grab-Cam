/* ScreenGrab service worker.
   The app shell is precached. OpenCV.js and Tesseract.js are cached on first
   use so the app keeps working offline afterwards. */

const VERSION = 'screengrab-v16';
/* Third-party engines (OpenCV, Tesseract) live in a stable cache so app
   updates do not force a 20 MB re-download. */
const RUNTIME_CACHE = 'screengrab-runtime-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/vision.js',
  './js/demo.js',
  './js/ocr.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];
const OPENCV_HOST = 'docs.opencv.org';
/* Tesseract.js, its core wasm and the English traineddata all come from here. */
const OCR_HOST = 'cdn.jsdelivr.net';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(
      SHELL.map(async (url) => {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch (err) {
          console.warn('[sw] could not precache', url, err);
        }
      })
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== VERSION && key !== RUNTIME_CACHE).map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  const fallback = async () =>
    (await cache.match('./index.html')) ||
    (await cache.match('./')) ||
    new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put('./index.html', fresh.clone()).catch(() => {});
      return fresh;
    }
    // A proxy or captive portal can answer with 5xx instead of failing the
    // request; prefer the cached shell in that case.
    return fallback();
  } catch {
    return fallback();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.hostname === OPENCV_HOST || url.hostname === OCR_HOST) {
    event.respondWith(cacheFirst(request));
  }
});
