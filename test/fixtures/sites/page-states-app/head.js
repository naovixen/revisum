// Rewrites the og:title meta tag the server sent, counts itself as a script run, and asks the
// server for script-ran.txt, so a test can see on the server too whether any page script ran.
document.querySelector('meta[property="og:title"]').setAttribute('content', 'Spring sale (rewritten)');
const scriptRunCounter = document.querySelector('[data-testid="script-runs"]');
scriptRunCounter.textContent = String(Number(scriptRunCounter.textContent) + 1);
fetch('/script-ran.txt');
