// Loaded before a stand-in taskkill starts. It writes the output the real taskkill gives and exits with the
// code a test asks for, optionally after running the real taskkill so the browser's tree really is ended, and
// optionally noting that it ran, for a stand-in browser to take as its cue.
const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const realTaskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

if (process.env.STAND_IN_TASKKILL_ENDS_THE_TREE === 'yes') {
  spawnSync(realTaskkill, process.argv.slice(1), { stdio: 'ignore', windowsHide: true });
}
if (process.env.STAND_IN_TASKKILL_RAN_FILE !== undefined) {
  writeFileSync(process.env.STAND_IN_TASKKILL_RAN_FILE, 'ran');
}
if (process.env.STAND_IN_TASKKILL_OUTPUT !== undefined) {
  process.stderr.write(process.env.STAND_IN_TASKKILL_OUTPUT);
}
process.exit(Number(process.env.STAND_IN_TASKKILL_EXIT_CODE));
