// A service worker that answers /api/worker-items itself, without the network, and controls the
// page as soon as it is active.
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname !== '/api/worker-items') return;
  const body = JSON.stringify({ source: 'service worker', items: [{ name: 'Cached kettle' }] });
  event.respondWith(new Response(body, { headers: { 'content-type': 'application/json' } }));
});
