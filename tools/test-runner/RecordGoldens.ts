// Remakes the recorded goldens, each from two separate runs that must give identical bytes:
//   test/golden/closed-language/hashes.json   the hashes of plans that use no unsafe features
//   test/golden/replay/windows-signup/*       a real browser run, made only on Windows x64
//   npm run goldens:record
// The recorders live in the test set, beside the tests that read what they record. Tools compile
// without the test set, so each recorder runs as a child process and prints its files as JSON.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..");
const GOLDEN = join(REPOSITORY_ROOT, "test", "golden");
const CLOSED_LANGUAGE_RECORDER = join(
    REPOSITORY_ROOT,
    "test",
    "support",
    "ClosedLanguageGolden.ts",
);
const WINDOWS_SIGNUP_RECORDER = join(REPOSITORY_ROOT, "test", "support", "WindowsSignupGolden.ts");

// Why this host can't remake the replay golden, or null when it can. The golden's manifest records
// the host and the browser executable's hash, so another machine would write its own baseline over
// the Windows one and the replay test could no longer prove a run replays as identical.
export function replayGoldenRefusal(host: {
    readonly platform: string;
    readonly arch: string;
}): string | null {
    if (host.platform === "win32" && host.arch === "x64") {
        return null;
    }
    return (
        `the replay golden is made on win32/x64 only, and this is ${host.platform}/${host.arch}: ` +
        "its manifest records the host and the browser executable's hash, so a run here is " +
        "another machine's baseline, not this golden"
    );
}

function recordOnce(recorder: string): string {
    const ran = spawnSync(process.execPath, [recorder], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
    });
    if (ran.status !== 0) {
        throw new Error(`${recorder} failed:\n${ran.stderr}`);
    }
    return ran.stdout;
}

function recordTwice(recorder: string): string {
    const first = recordOnce(recorder);
    if (recordOnce(recorder) !== first) {
        throw new Error(`two runs of ${recorder} differ, so nothing was written`);
    }
    return first;
}

function writeGoldenFiles(recorded: string): void {
    const files: unknown = JSON.parse(recorded);
    if (typeof files !== "object" || files === null) {
        throw new Error("a recorder printed something other than its files");
    }
    for (const [path, content] of Object.entries(files)) {
        const file = join(GOLDEN, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
        console.log(`wrote test/golden/${path}`);
    }
}

// Writes the closed-language golden and, on the one host that may make it, the replay golden.
// Returns the exit status: not 0 when the replay golden was refused.
export function recordGoldens(): number {
    const closedLanguage = recordTwice(CLOSED_LANGUAGE_RECORDER);
    const refusal = replayGoldenRefusal({ platform: process.platform, arch: process.arch });
    const windowsSignup = refusal === null ? recordTwice(WINDOWS_SIGNUP_RECORDER) : null;
    writeGoldenFiles(closedLanguage);
    if (windowsSignup === null) {
        console.error(`record goldens: ${refusal}`);
        return 1;
    }
    writeGoldenFiles(windowsSignup);
    return 0;
}

if (import.meta.main) {
    process.exitCode = recordGoldens();
}
