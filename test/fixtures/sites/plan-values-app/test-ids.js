// Test-id fixture: every button says which one it is when clicked.
const shown = (testId) => document.querySelector(`[data-testid="${testId}"]`);
let buttonClicks = 0;
for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', () => {
    buttonClicks += 1;
    shown('button-clicks').textContent = String(buttonClicks);
    shown('clicked').textContent = button.dataset.result;
  });
}
