// Stands in for a browser, for a test of stopping one. It starts a process of its own that, like a crashpad
// handler, outlives it unless its whole tree is ended and names the profile folder on its command line. It
// announces a DevTools address and accepts the connection, but answers nothing, so asking it to close fails.
// Usage: node browser-that-leaves-a-process.cjs <file to write the process's id to> <the browser's flags>
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:http');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const [, , leftoverIdFile, ...flags] = process.argv;
const profileFlag = flags.find((flag) => flag.startsWith('--user-data-dir='));

// Ends itself in the end, so a failed test leaves nothing behind for long.
const leftover = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)', '--', profileFlag], { stdio: 'ignore', windowsHide: true });
writeFileSync(leftoverIdFile, String(leftover.pid));

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
