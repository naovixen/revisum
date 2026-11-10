// The Continue button every page has: it says it was pressed, so a test can show that a step after
// a refused one was never sent.
document.querySelector('#continue').addEventListener('click', () => {
  document.querySelector('[data-testid="continue-state"]').textContent = 'Continued';
});
