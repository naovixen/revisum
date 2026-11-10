// Opens the Returns notes disclosure on click, so a state check can see a state the page changed.
const returnsButton = document.querySelector('[data-testid="returns-disclosure"]');
const returnsNotes = document.getElementById('returns-notes');
returnsButton.addEventListener('click', () => {
  const opening = returnsButton.getAttribute('aria-expanded') !== 'true';
  returnsButton.setAttribute('aria-expanded', String(opening));
  returnsNotes.hidden = !opening;
});
