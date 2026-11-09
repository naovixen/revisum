// Remembered-value fixture: a text over the length limit, a text that appears late, and a button
// that counts its clicks.
const shown = (testId) => document.querySelector(`[data-testid="${testId}"]`);
shown('long-value').textContent = 'x'.repeat(501);
setTimeout(() => { shown('late-value').textContent = 'LATE-4471'; }, 400);
let saveClicks = 0;
document.getElementById('save').addEventListener('click', () => { saveClicks += 1; shown('save-clicks').textContent = String(saveClicks); });
