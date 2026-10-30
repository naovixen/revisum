// Served at /api/assets/frame-message.js: tells the parent page that the server's frame loaded.
window.parent.postMessage('frame from server', '*');
