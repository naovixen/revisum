// Forms fixture: each field counts the Enter key presses it receives, and a submitted form is
// recorded by its id and never leaves the page.
const shown = (testId) => document.querySelector(`[data-testid="${testId}"]`);
const enterCounts = { reason: 0, nickname: 0 };
for (const id of Object.keys(enterCounts)) {
  document.getElementById(id).addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    enterCounts[id] += 1;
    shown(`${id}-enters`).textContent = String(enterCounts[id]);
  });
}
for (const form of document.querySelectorAll('form')) {
  form.addEventListener('submit', (event) => { event.preventDefault(); shown('submitted').textContent = form.id; });
}
