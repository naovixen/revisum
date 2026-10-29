// Runs as a dedicated worker of worker.html and asks an undeclared origin for data.
fetch('http://worker.invalid/data', { mode: 'no-cors' })
  .then(() => { postMessage('answered'); }, () => { postMessage('failed'); });
