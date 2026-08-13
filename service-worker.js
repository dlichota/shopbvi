/**
 * Larder Flow service worker.
 *
 * Strategy:
 *   navigations  → network-first (with navigation preload), falling back to the
 *                  precached app shell so the app opens offline.
 *   same-origin  → stale-while-revalidate, so icons/manifest load instantly and
 *                  refresh in the background.
 *   fonts        → cache-first, since Fontshare assets are immutable per URL.
 *
 * Bump CACHE_VERSION whenever the precached shell changes.
 */
const CACHE_VERSION = 'v5';
const PRECACHE = `larder-flow-precache-${CACHE_VERSION}`;
const RUNTIME = `larder-flow-runtime-${CACHE_VERSION}`;
const APP_SHELL = '/index.html';

const PRECACHE_URLS = [
  '/',
  APP_SHELL,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.svg',
  '/icons/favicon-32.png',
];

const FONT_ORIGINS = ['https://api.fontshare.com', 'https://cdn.fontshare.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // The shell must be cached for the app to work offline; the rest is
      // best-effort so one missing asset can't fail the whole install.
      await cache.addAll([new Request('/', { cache: 'reload' })]);
      await Promise.allSettled(
        PRECACHE_URLS.filter((url) => url !== '/').map((url) =>
          cache.add(new Request(url, { cache: 'reload' }))
        )
      );
      // No skipWaiting() here on purpose: the page offers a "Refresh" prompt and
      // posts SKIP_WAITING, so an update never reloads the app mid-edit.
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== PRECACHE && key !== RUNTIME).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function handleNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) {
      const cache = await caches.open(PRECACHE);
      cache.put('/', preloaded.clone());
      return preloaded;
    }
    const network = await fetch(event.request);
    const cache = await caches.open(PRECACHE);
    cache.put('/', network.clone());
    return network;
  } catch {
    const cached = (await caches.match('/')) || (await caches.match(APP_SHELL));
    if (cached) return cached;
    return new Response('<h1>Offline</h1><p>Larder Flow is not cached yet.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Sheet sync must always hit the network: the app queues its own changes in
  // localStorage and replays them, so a cached API response would be worse than
  // a failed one.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request, { cacheName: PRECACHE }).then((precached) => {
        if (precached) return precached;
        return staleWhileRevalidate(request);
      })
    );
    return;
  }

  if (FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(cacheFirst(request).catch(() => caches.match(request)));
  }
});
