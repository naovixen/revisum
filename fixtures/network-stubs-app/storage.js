// Shows what this page's own storage holds, so a test can see what a storage write really wrote:
// the local key navigation.docked and the session key visit.greeting.
const show = () => {
  document.querySelector('[data-testid="stored-docked"]').textContent = localStorage.getItem('navigation.docked') ?? '(none)';
  document.querySelector('[data-testid="stored-greeting"]').textContent = sessionStorage.getItem('visit.greeting') ?? '(none)';
};
show();
setInterval(show, 50);
