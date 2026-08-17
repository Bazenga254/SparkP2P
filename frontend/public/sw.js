// Self-destroying service worker.
//
// Older builds of SparkP2P shipped a PWA service worker (vite-plugin-pwa). The current app
// registers NO service worker, but those old ("zombie") SWs keep running in clients' browsers and
// serve a CACHED, stale index.html that points at JS bundles later rebuilds have deleted (404) —
// which leaves React unable to boot and the window blank/black. This script replaces any such
// zombie: on activate it clears every cache, unregisters itself, and hard-reloads open tabs so
// they load the fresh, service-worker-free page. Healthy clients never register this (nothing calls
// serviceWorker.register anymore); only clients that already have a /sw.js registration pick up this
// update on their next navigation and self-heal.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) { /* ignore */ }
    try { await self.registration.unregister(); } catch (_) { /* ignore */ }
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try { client.navigate(client.url); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
  })());
});
