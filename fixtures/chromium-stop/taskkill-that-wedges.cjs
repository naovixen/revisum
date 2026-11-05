// Loaded before a stand-in taskkill starts: it notes its process id and then never answers, as a taskkill
// wedged on a process it cannot end would. It ends itself in the end, so a failed test leaves nothing behind for long.
const { writeFileSync } = require('node:fs');

writeFileSync(process.env.WEDGED_TASKKILL_ID_FILE, String(process.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90000);
process.exit(1);
