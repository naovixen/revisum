// Shows what the page can read of the session's storage and clock.
document.querySelector('[data-testid="stored-name"]').textContent = localStorage.getItem('displayName') ?? 'none';
document.querySelector('[data-testid="page-now"]').textContent = String(Date.now());
