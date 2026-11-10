// A session that expires 10 minutes after the page loads, and a button that shows how far the
// page's two clocks have moved since then. performance.now() is shown to the microsecond, its
// own precision, so the sum of whole-millisecond advances reads as a whole number.
const loadedAt = Date.now();
const loadedAtPerformanceTime = performance.now();
setTimeout(() => { show('session-status', 'Session expired'); }, 10 * 60 * 1000);
document.querySelector('#show-elapsed').addEventListener('click', () => {
  const now = Date.now();
  show('date-now', String(now));
  show('date-elapsed', String(now - loadedAt));
  show('performance-elapsed', String(Math.round((performance.now() - loadedAtPerformanceTime) * 1000) / 1000));
});
