// Each button says it was pressed, so a test can show which clicks reached the page.
const show = (id, text) => { document.querySelector(`[data-testid="${id}"]`).textContent = text; };
document.querySelector('button.danger').addEventListener('click', () => show('account-state', 'Account deleted'));
document.querySelector('button.safe').addEventListener('click', () => show('details-state', 'Details shown'));
document.querySelector('button.icon-close').addEventListener('click', () => show('toolbar-state', 'Toolbar closed'));
document.querySelector('button.icon-menu').addEventListener('click', () => show('toolbar-state', 'Menu opened'));
