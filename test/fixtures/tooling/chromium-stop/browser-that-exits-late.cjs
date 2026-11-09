// Stands in for a browser whose exit is slow to be seen, as one is under load after taskkill has ended it. It
// announces a DevTools address and accepts the connection, then exits a set time after a stand-in taskkill has
// noted that it ran. Ends itself in the end, so a failed test leaves nothing behind for long.
// Usage: node browser-that-exits-late.cjs <the file the taskkill notes it ran in> <exit delay in milliseconds>
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { createServer } = require('node:http');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const POLL_MILLISECONDS = 25;
const [, , ranFile, exitDelay] = process.argv;

setTimeout(() => process.exit(0), 90000);

const poll = setInterval(() => {
  if (existsSync(ranFile)) {
    clearInterval(poll);
    setTimeout(() => process.exit(0), Number(exitDelay));
  }
}, POLL_MILLISECONDS);

const server = createServer();
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${WEBSOCKET_GUID}`).digest('base64');
  socket.on('error', () => {});
  socket.resume();
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});
server.listen(0, '127.0.0.1', () => {
  console.error(`DevTools listening on ws://127.0.0.1:${server.address().port}/`);
});
