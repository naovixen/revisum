// Registers, in this order as the page loads: a timeout at 50 ms, two timeouts at 100 ms, and an
// interval every 30 ms. The 50 ms timeout queues a promise job and schedules one more timeout
// 20 ms later. Every callback records its name and the page's own time since it loaded.
const loadedAt = Date.now();
const log = [];
const counts = {
  'interval-30': 0, 'timeout-50': 0, 'promise-after-timeout-50': 0, 'nested-timeout-20': 0, 'timeout-100-first': 0, 'timeout-100-second': 0,
};
const render = () => {
  show('timer-log', log.length === 0 ? '(none)' : log.join(', '));
  show('timer-counts', Object.entries(counts).map(([name, count]) => `${name}:${count}`).join(', '));
  const times = [...new Set(log.map((entry) => entry.split('@')[1]))];
  show('timer-times', times.length === 0 ? '(none)' : times.join(', '));
};
const record = (name) => {
  counts[name] += 1;
  log.push(`${name}@${Date.now() - loadedAt}`);
  render();
};
render();
setTimeout(() => {
  record('timeout-50');
  Promise.resolve().then(() => record('promise-after-timeout-50'));
  setTimeout(() => record('nested-timeout-20'), 20);
}, 50);
setTimeout(() => record('timeout-100-first'), 100);
setTimeout(() => record('timeout-100-second'), 100);
setInterval(() => record('interval-30'), 30);
