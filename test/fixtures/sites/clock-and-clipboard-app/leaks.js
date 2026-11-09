// Copies the personal data the page shows, a name, or the secret typed into the token field, so a
// leak scan can show that neither reaches what the run keeps. The copy state says only how much was copied.
const copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    show('copy-state', `Copied ${text.length} characters`);
  } catch (error) {
    show('copy-state', `Copy refused: ${error.name}`);
  }
};
document.querySelector('#copy-contact').addEventListener('click', () => {
  copy(document.querySelector('[data-testid="contact-name"]').textContent.trim());
});
document.querySelector('#copy-token').addEventListener('click', () => { copy(document.querySelector('#access-token').value); });
