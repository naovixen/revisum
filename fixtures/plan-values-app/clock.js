// Shows the page's own clock as it loads, so a plan can check the time the driver froze it at.
document.querySelector('[data-testid="page-now"]').textContent = String(Date.now());
document.querySelector('[data-testid="page-time"]').textContent = new Date().toISOString();
