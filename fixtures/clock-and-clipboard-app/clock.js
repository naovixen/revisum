// Shows the page's own clock as it loads, and again on request.
show('page-now', String(Date.now()));
document.querySelector('#show-now').addEventListener('click', () => { show('now-on-request', String(Date.now())); });
