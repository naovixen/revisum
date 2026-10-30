// Registers the service worker and waits until it controls the page, then lets the button fetch
// /api/worker-items. The worker answers that path itself; the server and a stub answer it with
// their own source, so the page shows which of the three answered.
const shown = (id) => document.querySelector(`[data-testid="${id}"]`);
const ready = () => { shown('worker-state').textContent = 'Worker ready'; };

if (!('serviceWorker' in navigator)) {
  shown('worker-state').textContent = 'No service workers here';
} else {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      if (navigator.serviceWorker.controller !== null) ready();
      else navigator.serviceWorker.addEventListener('controllerchange', ready, { once: true });
    })
    .catch((error) => { shown('worker-state').textContent = `Worker failed: ${error.name}`; });
}

let answers = 0;
document.querySelector('#worker-items').addEventListener('click', async () => {
  const response = await fetch('/api/worker-items');
  const body = await response.json();
  answers += 1;
  shown('items-source').textContent = String(body.source);
  shown('answer-count').textContent = String(answers);
});
