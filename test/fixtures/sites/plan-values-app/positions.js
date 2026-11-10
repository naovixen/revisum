// Positions fixture: each "Open" button says which of the three it is when clicked, and the
// quantities line shows every Quantity field's value in document order.
const shown = (testId) => document.querySelector(`[data-testid="${testId}"]`);
let openClicks = 0;
for (const button of document.querySelectorAll('[data-testid="open-order"]')) {
  button.addEventListener('click', () => {
    openClicks += 1;
    shown('open-clicks').textContent = String(openClicks);
    shown('opened').textContent = button.dataset.position;
  });
}
const quantities = Array.from(document.querySelectorAll('.quantity'));
const showQuantities = () => { shown('quantities').textContent = quantities.map((field) => field.value || '-').join(','); };
for (const field of quantities) field.addEventListener('input', showQuantities);
