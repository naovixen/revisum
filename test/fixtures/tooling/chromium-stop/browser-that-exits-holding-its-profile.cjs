// Stands in for a browser that dies during start-up, for a test of stopping one. It first starts a process
// that holds the profile folder as its working folder, which on Windows keeps the folder from being removed.
// Usage: node browser-that-exits-holding-its-profile.cjs <file to write the process's id to> <the browser's flags>
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const PROFILE_FLAG = '--user-data-dir=';
const [, , holderIdFile, ...flags] = process.argv;
const profile = flags.find((flag) => flag.startsWith(PROFILE_FLAG)).slice(PROFILE_FLAG.length);
const held = join(profile, 'held');
mkdirSync(held);

// Ends itself in the end, so a failed test leaves nothing behind for long.
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)'], { cwd: held, stdio: 'ignore', windowsHide: true, detached: true });
holder.unref();
writeFileSync(holderIdFile, String(holder.pid));
process.exit(3);
