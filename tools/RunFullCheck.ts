// The whole push check on the full test tier: what a push run leaves out, such as repeated runs and
// the headless-shell target. It sets the tier here because an npm script can't set a variable in a
// way that works on both Windows and Linux. test/support/TestTier.ts reads it.
//   npm run check:full
import { spawnSync } from "node:child_process";

process.env["REVISUM_TEST_TIER"] = "full";

const run = spawnSync("npm run check:push", {
    stdio: "inherit",
    // On Windows npm is a command script, which only a shell can start.
    shell: true,
});

process.exitCode = run.status ?? 1;
