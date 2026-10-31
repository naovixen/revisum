async () => {
  // Tries to reach three undeclared origins, one per channel, after one request to the page's own
  // origin. Each .invalid name can never resolve, so nothing reaches the network even if unblocked.
  const settled = [];
  settled.push(await fetch('/egress-allowed.json').then((response) => response.status, () => 'refused'));
  settled.push(await fetch('http://page.invalid/script-fetch').then((response) => response.status, () => 'refused'));
  settled.push(await new Promise((resolve) => {
    const socket = new WebSocket('ws://socket.invalid/script-socket');
    socket.addEventListener('open', () => { socket.close(); resolve('opened'); });
    socket.addEventListener('error', () => resolve('refused'));
    setTimeout(() => resolve('no answer'), 3000);
  }));
  settled.push(navigator.sendBeacon('http://beacon.invalid/script-beacon', 'beacon body') ? 'queued' : 'refused');
  // Gives the beacon time to leave the page before the run closes the browser.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { attempts: settled.length };
}
